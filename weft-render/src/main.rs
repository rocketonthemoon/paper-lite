//! weft-render: renders weft artboards with Blitz instead of headless Chrome.
//!
//! It runs as a long-lived sidecar of the weft server (renderer-blitz.js). Requests and answers are JSON, one per
//! line, on stdin / stdout:
//!
//! - `{"id":1,"op":"load","html":"…","baseUrl":"http://…/","width":800,"height":600,"assetsKey":"3"}`
//! - `{"id":2,"op":"screenshot","nodeId":"…","scale":1,"maxSize":1600}` → `{"png":"<base64>","width","height","scale"}`
//! - `{"id":3,"op":"computed","artboardId":"…","nodeIds":[…],"properties":[…]}` → `{ "<id>": { box, styles } | null }`
//!
//! Each answer is `{"id":…,"ok":true,"result":…}` or `{"id":…,"ok":false,"error":"…"}`. A loaded document stays laid
//! out until the next `load`, so several calls on the same artboard pay for parsing and layout once. Layers are found by
//! their `data-layer` attribute, as on the /render page.
//!
//! Stylesheets, fonts and images are fetched once and kept in memory (like a browser's HTTP cache) until `assetsKey`
//! changes, which the server bumps when the font library changes.
//!
//! The generic families `serif` and `sans-serif` (and text with no font-family, which is serif) resolve to the fonts
//! Chrome uses by default (Times New Roman, Arial, or their metric-compatible stand-ins), not to whatever the system
//! lists first for those names, so text wraps the same as in headless Chrome.
use anyrender::{render_to_buffer, AntiAliasing, PaintScene as _};
use anyrender_vello_cpu::VelloCpuImageRenderer;
use base64::Engine as _;
use blitz_dom::{util::Color, DocumentConfig};
use blitz_html::HtmlDocument;
use blitz_net::Provider;
use blitz_paint::paint_scene;
use blitz_traits::shell::{ColorScheme, Viewport};
use blitz_traits::net::{Bytes, Method, NetHandler, NetProvider, Request as NetRequest};
use blitz_traits::NodeId;
use std::collections::HashMap;
use std::sync::Mutex;
use parley::fontique::GenericFamily;
use parley::FontContext;
use peniko::{kurbo::Rect, Fill};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::io::{BufRead, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Op {
    #[serde(rename_all = "camelCase")]
    Load { html: String, base_url: String, width: u32, height: u32, #[serde(default)] assets_key: String },
    #[serde(rename_all = "camelCase")]
    Screenshot { node_id: String, #[serde(default = "one")] scale: f64, #[serde(default = "max_size")] max_size: f64 },
    #[serde(rename_all = "camelCase")]
    Computed { artboard_id: String, node_ids: Vec<String>, properties: Vec<String> },
}
fn one() -> f64 { 1.0 }
fn max_size() -> f64 { 1600.0 }

#[derive(Deserialize)]
struct Request {
    id: Value,
    #[serde(flatten)]
    op: Op,
}

struct Loaded {
    doc: HtmlDocument,
}

// The values headless Chrome's computed() leaves out (renderer.js), so both renderers answer alike.
const SKIP: [&str; 5] = ["none", "normal", "auto", "0px", "rgba(0, 0, 0, 0)"];
// Fonts and images: wait this long at most for them to load.
const ASSET_TIMEOUT: Duration = Duration::from_secs(5);

/// Fetched resources by URL: the bytes and the URL they resolved to, or the error. Failed fetches are remembered too,
/// so an unreachable host (e.g. Google Fonts when offline) costs one attempt, not one per render.
type Cached = Result<(String, Bytes), String>;

struct CachingProvider {
    inner: Arc<Provider>,
    cache: Arc<Mutex<HashMap<String, Cached>>>,
}

impl NetProvider for CachingProvider {
    fn fetch(&self, doc_id: usize, request: NetRequest, handler: Box<dyn NetHandler>) {
        if request.method != Method::GET {
            return self.inner.fetch(doc_id, request, handler);
        }
        let url = request.url.to_string();
        let hit = self.cache.lock().unwrap().get(&url).cloned();
        match hit {
            Some(Ok((resolved, bytes))) => handler.bytes(resolved, bytes),
            Some(Err(error)) => handler.error(url, error),
            None => self.inner.fetch(doc_id, request, Box::new(Remember { url, cache: Arc::clone(&self.cache), handler })),
        }
    }
}

struct Remember {
    url: String,
    cache: Arc<Mutex<HashMap<String, Cached>>>,
    handler: Box<dyn NetHandler>,
}

impl NetHandler for Remember {
    fn bytes(self: Box<Self>, resolved_url: String, bytes: Bytes) {
        self.cache.lock().unwrap().insert(self.url.clone(), Ok((resolved_url.clone(), bytes.clone())));
        self.handler.bytes(resolved_url, bytes)
    }
    fn error(self: Box<Self>, url: String, error: String) {
        self.cache.lock().unwrap().insert(self.url.clone(), Err(error.clone()));
        self.handler.error(url, error)
    }
}

struct Assets {
    key: String,
    cache: Arc<Mutex<HashMap<String, Cached>>>,
    fonts: FontContext,
}

// Chrome's default fonts for the generic families, by platform, followed by metric-compatible replacements that
// fontconfig substitutes for them (Liberation, Croscore) on Linux. The first one installed is used.
#[cfg(target_os = "macos")]
const CHROME_GENERICS: &[(GenericFamily, &[&str])] = &[
    (GenericFamily::Serif, &["Times", "Times New Roman"]),
    (GenericFamily::SansSerif, &["Helvetica", "Arial"]),
    (GenericFamily::Monospace, &["Courier", "Courier New"]),
];
#[cfg(target_os = "windows")]
const CHROME_GENERICS: &[(GenericFamily, &[&str])] = &[
    (GenericFamily::Serif, &["Times New Roman"]),
    (GenericFamily::SansSerif, &["Arial"]),
    (GenericFamily::Monospace, &["Consolas", "Courier New"]),
];
// On Linux Chrome's monospace is fontconfig's "Monospace", which is what the system collection already returns.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const CHROME_GENERICS: &[(GenericFamily, &[&str])] = &[
    (GenericFamily::Serif, &["Times New Roman", "Liberation Serif", "Tinos", "Times", "Nimbus Roman"]),
    (GenericFamily::SansSerif, &["Arial", "Liberation Sans", "Arimo", "Helvetica", "Nimbus Sans"]),
];

/// System fonts, with the generic families put first on Chrome's defaults (the rest stay as fallbacks).
fn chrome_like_fonts() -> FontContext {
    let mut fonts = FontContext::new();
    for (generic, names) in CHROME_GENERICS {
        let Some(id) = names.iter().find_map(|n| fonts.collection.family_id(n)) else { continue };
        let rest: Vec<_> = fonts.collection.generic_families(*generic).filter(|f| *f != id).collect();
        fonts.collection.set_generic_families(*generic, std::iter::once(id).chain(rest));
    }
    fonts
}

fn main() {
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    let _guard = runtime.enter();
    let mut loaded: Option<Loaded> = None;
    let mut assets = Assets { key: String::new(), cache: Arc::new(Mutex::new(HashMap::new())), fonts: chrome_like_fonts() };
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Request>(&line) {
            Ok(req) => match handle(req.op, &mut loaded, &mut assets) {
                Ok(result) => json!({ "id": req.id, "ok": true, "result": result }),
                Err(error) => json!({ "id": req.id, "ok": false, "error": error }),
            },
            Err(err) => {
                let id = serde_json::from_str::<Value>(&line).ok().and_then(|v| v.get("id").cloned()).unwrap_or(Value::Null);
                json!({ "id": id, "ok": false, "error": format!("bad request: {err}") })
            }
        };
        if writeln!(stdout, "{reply}").and_then(|_| stdout.flush()).is_err() {
            break;
        }
    }
}

fn handle(op: Op, loaded: &mut Option<Loaded>, assets: &mut Assets) -> Result<Value, String> {
    match op {
        Op::Load { html, base_url, width, height, assets_key } => {
            let started = Instant::now();
            if assets_key != assets.key {
                assets.key = assets_key;
                assets.cache.lock().unwrap().clear();
            }
            *loaded = Some(load(&html, &base_url, width.max(1), height.max(1), &assets.cache, &assets.fonts));
            Ok(json!({ "ms": started.elapsed().as_millis() as u64 }))
        }
        Op::Screenshot { node_id, scale, max_size } => {
            let l = loaded.as_mut().ok_or("nothing loaded")?;
            screenshot(l, &node_id, scale, max_size)
        }
        Op::Computed { artboard_id, node_ids, properties } => {
            let l = loaded.as_mut().ok_or("nothing loaded")?;
            computed(l, &artboard_id, &node_ids, &properties)
        }
    }
}

fn load(html: &str, base_url: &str, width: u32, height: u32, cache: &Arc<Mutex<HashMap<String, Cached>>>, fonts: &FontContext) -> Loaded {
    let net = Arc::new(Provider::new(None));
    let provider = Arc::new(CachingProvider { inner: Arc::clone(&net), cache: Arc::clone(cache) });
    let mut doc = HtmlDocument::from_html(
        html,
        DocumentConfig {
            base_url: Some(base_url.to_string()),
            net_provider: Some(provider as _),
            // A copy per document: web fonts a page loads stay with that page.
            font_ctx: Some(fonts.clone()),
            viewport: Some(Viewport::new(width, height, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    );
    // Fetch stylesheets, fonts and images (each load can discover more), then lay out.
    let deadline = Instant::now() + ASSET_TIMEOUT;
    loop {
        doc.resolve(0.0);
        if net.is_empty() || Instant::now() > deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(2));
    }
    doc.as_mut().resolve(0.0);
    Loaded { doc }
}

fn find(l: &Loaded, id: &str) -> Option<NodeId> {
    let sel = format!("[data-layer=\"{}\"]", id.replace('\\', "\\\\").replace('"', "\\\""));
    l.doc.as_ref().query_selector(&sel).ok().flatten()
}

fn screenshot(l: &mut Loaded, node_id: &str, scale: f64, max_size: f64) -> Result<Value, String> {
    let node = find(l, node_id).ok_or("Node has no visible box to capture")?;
    let r = l.doc.as_ref().get_client_bounding_rect(node).ok_or("Node has no visible box to capture")?;
    if r.width < 1.0 || r.height < 1.0 {
        return Err("Node has no visible box to capture".into());
    }
    let s = scale.min(max_size / r.width.max(r.height));
    let (w, h) = ((r.width * s).round().max(1.0) as u32, (r.height * s).round().max(1.0) as u32);
    // paint_scene can only shift the drawing right / down, so paint from the page's top-left to the node's bottom-right
    // corner and crop the node out of that.
    let (ox, oy) = ((r.x * s).round().max(0.0) as u32, (r.y * s).round().max(0.0) as u32);
    let (fw, fh) = (ox + w, oy + h);
    let doc = l.doc.as_mut();
    let full = render_to_buffer::<VelloCpuImageRenderer, _>(
        |scene| {
            scene.fill(Fill::NonZero, Default::default(), Color::WHITE, Default::default(), &Rect::new(0.0, 0.0, fw as f64, fh as f64), AntiAliasing::Enabled);
            paint_scene(scene, doc, s, fw, fh, 0, 0);
        },
        fw,
        fh,
    );
    let mut buffer = Vec::with_capacity((w * h * 4) as usize);
    for row in oy..oy + h {
        let start = ((row * fw + ox) * 4) as usize;
        buffer.extend_from_slice(&full[start..start + (w * 4) as usize]);
    }
    let mut png_bytes = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut png_bytes, w, h);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&unpremultiply(buffer)).map_err(|e| e.to_string())?;
    }
    Ok(json!({
        "png": base64::engine::general_purpose::STANDARD.encode(png_bytes),
        "width": w, "height": h, "scale": (s * 1000.0).round() / 1000.0,
    }))
}

// vello_cpu writes premultiplied alpha; PNG wants straight alpha. (The page is painted over white, so this only
// matters where nothing is opaque, but keep the pixels honest.)
fn unpremultiply(mut buf: Vec<u8>) -> Vec<u8> {
    for px in buf.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a != 0 && a != 255 {
            for c in &mut px[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    buf
}

// A node's box as getBoundingClientRect reports it: its layout box with its own transform and every ancestor's
// applied (rotate, scale, translate, transform, around transform-origin), then the bounding box of the result.
// Blitz's get_client_bounding_rect returns the untransformed box.
fn transformed_rect(l: &mut Loaded, node: NodeId) -> Option<(f64, f64, f64, f64)> {
    let doc = l.doc.as_mut();
    let r = doc.get_client_bounding_rect(node)?;
    let mut pts = [(r.x, r.y), (r.x + r.width, r.y), (r.x, r.y + r.height), (r.x + r.width, r.y + r.height)];
    let mut cur = Some(node);
    while let Some(id) = cur {
        let origin = doc.get_client_bounding_rect(id).map(|b| (b.x, b.y));
        let affine = doc.get_node_mut(id).and_then(|n| n.set_transform(1.0));
        if let (Some((ox, oy)), Some(a)) = (origin, affine) {
            let [m11, m12, m21, m22, tx, ty] = a.as_coeffs();
            for p in &mut pts {
                let (x, y) = (p.0 - ox, p.1 - oy);
                *p = (ox + m11 * x + m21 * y + tx, oy + m12 * x + m22 * y + ty);
            }
        }
        cur = doc.get_node(id).and_then(|n| n.parent);
    }
    let (xs, ys): (Vec<f64>, Vec<f64>) = pts.iter().copied().unzip();
    let (x0, y0) = (xs.iter().copied().fold(f64::INFINITY, f64::min), ys.iter().copied().fold(f64::INFINITY, f64::min));
    let (x1, y1) = (xs.iter().copied().fold(f64::NEG_INFINITY, f64::max), ys.iter().copied().fold(f64::NEG_INFINITY, f64::max));
    Some((x0, y0, x1 - x0, y1 - y0))
}

fn computed(l: &mut Loaded, artboard_id: &str, node_ids: &[String], properties: &[String]) -> Result<Value, String> {
    let root = find(l, artboard_id).and_then(|n| transformed_rect(l, n)).ok_or("artboard not found")?;
    let mut out = Map::new();
    for id in node_ids {
        let Some(node) = find(l, id) else {
            out.insert(id.clone(), Value::Null);
            continue;
        };
        let Some((x, y, w, h)) = transformed_rect(l, node) else {
            out.insert(id.clone(), Value::Null);
            continue;
        };
        let doc = l.doc.as_ref();
        let mut styles = Map::new();
        for p in properties {
            let v = doc.resolved_style_value(node, p);
            if !v.is_empty() && !SKIP.contains(&v.as_str()) {
                styles.insert(p.clone(), Value::String(v));
            }
        }
        out.insert(id.clone(), json!({
            "box": {
                "x": (x - root.0).round() as i64, "y": (y - root.1).round() as i64,
                "width": w.round() as i64, "height": h.round() as i64,
            },
            "styles": styles,
        }));
    }
    Ok(Value::Object(out))
}
