/* ============================================================
   検証用: Google Drive v3 の小さな偽物（メモリ上）

   アプリが使う範囲だけを真似る:
     GET    /drive/v3/files?q=...&spaces=...&orderBy=createdTime   一覧（検索）
     GET    /drive/v3/files/{id}?fields=...                         メタデータ
     GET    /drive/v3/files/{id}?alt=media                          中身
     POST   /upload/drive/v3/files?uploadType=multipart|media       作成
     PATCH  /upload/drive/v3/files/{id}?uploadType=media|multipart  中身の置き換え
     PATCH  /drive/v3/files/{id}                                    メタデータ（trashed など）
     POST   /drive/v3/files                                         メタデータだけで作成
     DELETE /drive/v3/files/{id}                                    削除
   トークンは gis-stub.js が作る "fake." + base64(scope)。appDataFolder は drive.appdata、
   それ以外は drive.file が無いと 403 を返す（本物と同じく権限の不足で落ちる）。

   テスト用のつまみ:
     drive.files               … Map<id, file>
     drive.expireAll()         … 以後のリクエストを 401 にする（次に新しいトークンが来るまで）
     drive.failNext(n, status) … 次の n 回を status で失敗させる
     drive.hang(pred)          … pred(req) が真のリクエストに返事をしない（タイムアウト検証）
     drive.log                 … 受けたリクエストの記録 [{method, path, query}]
   ============================================================ */

let clock = Date.parse("2026-10-01T00:00:00.000Z");
function nowIso() { clock += 1000; return new Date(clock).toISOString(); }

function parseQ(q) {
  const out = { names: [], contains: [], parents: [], trashed: null, mime: null };
  if (!q) return out;
  const str = (s) => s.replace(/\\'/g, "'");
  let m;
  const reName = /name\s*=\s*'((?:[^'\\]|\\.)*)'/g;
  while ((m = reName.exec(q))) out.names.push(str(m[1]));
  const reCont = /name\s+contains\s+'((?:[^'\\]|\\.)*)'/g;
  while ((m = reCont.exec(q))) out.contains.push(str(m[1]));
  const rePar = /'((?:[^'\\]|\\.)*)'\s+in\s+parents/g;
  while ((m = rePar.exec(q))) out.parents.push(str(m[1]));
  if (/trashed\s*=\s*false/.test(q)) out.trashed = false;
  if (/trashed\s*=\s*true/.test(q)) out.trashed = true;
  const reMime = /mimeType\s*=\s*'([^']*)'/.exec(q);
  if (reMime) out.mime = reMime[1];
  return out;
}

function parseMultipart(buf, ctype) {
  const bm = /boundary=("?)([^";]+)\1/i.exec(ctype || "");
  if (!bm) return null;
  const boundary = "--" + bm[2];
  const s = buf.toString("latin1");
  const parts = s.split(boundary).slice(1).filter((p) => !p.startsWith("--"));
  return parts.map((p) => {
    const i = p.indexOf("\r\n\r\n");
    const head = p.slice(0, i), body = p.slice(i + 4).replace(/\r\n$/, "");
    const ct = (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1] || "";
    return { ctype: ct.trim(), body: Buffer.from(body, "latin1") };
  });
}

export function createFakeDrive() {
  const files = new Map();
  let seq = 0;
  let expired = false, failQueue = [], hangPred = null;
  const log = [];

  function scopesOf(req) {
    const a = req.headers()["authorization"] || "";
    const m = /^Bearer fake\.(.*)$/.exec(a);
    if (!m) return null;
    try { return Buffer.from(m[1], "base64").toString("utf8").split(/\s+/).filter(Boolean); } catch (e) { return null; }
  }
  function canSee(f, scopes) {
    const inApp = (f.parents || []).includes("appDataFolder");
    return inApp ? scopes.some((s) => /drive\.appdata$/.test(s)) : scopes.some((s) => /drive\.file$|\/auth\/drive$/.test(s));
  }
  function metaOut(f, fields) {
    const all = { kind: "drive#file", id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, createdTime: f.createdTime,
      modifiedTime: f.modifiedTime, trashed: !!f.trashed, size: String(f.content.length), appProperties: f.appProperties || undefined };
    if (!fields) return { kind: all.kind, id: all.id, name: all.name, mimeType: all.mimeType };
    const want = fields.replace(/^files\(|\)$/g, "").split(",").map((x) => x.trim()).filter(Boolean);
    const o = {};
    want.forEach((k) => { if (all[k] !== undefined) o[k] = all[k]; });
    return o;
  }
  const json = (route, status, obj) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(obj) });
  const err = (route, status, msg) => json(route, status, { error: { code: status, message: msg || String(status) } });

  function create(meta, content, ctype) {
    const id = "f" + (++seq).toString(36) + Math.random().toString(36).slice(2, 6);
    const t = nowIso();
    const f = { id, name: meta.name || "untitled", mimeType: meta.mimeType || ctype || "application/octet-stream",
      parents: meta.parents || [], createdTime: t, modifiedTime: t, trashed: false, content: content || Buffer.alloc(0),
      appProperties: meta.appProperties };
    files.set(id, f);
    return f;
  }

  async function handle(route) {
    const req = route.request();
    const u = new URL(req.url());
    const method = req.method();
    log.push({ method, path: u.pathname, query: u.search });
    if (hangPred && hangPred(req)) return; // 返事をしない
    if (failQueue.length) { const st = failQueue.shift(); return err(route, st); }
    const scopes = scopesOf(req);
    if (!scopes || expired) return err(route, 401, "Invalid Credentials");
    const p = u.pathname;
    const idm = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(p);

    // 一覧
    if (method === "GET" && p === "/drive/v3/files") {
      const q = parseQ(u.searchParams.get("q") || "");
      const spaces = (u.searchParams.get("spaces") || "drive").split(",");
      let list = [...files.values()].filter((f) => {
        const inApp = (f.parents || []).includes("appDataFolder");
        if (inApp && !spaces.includes("appDataFolder")) return false;
        if (!inApp && !spaces.includes("drive")) return false;
        if (!canSee(f, scopes)) return false;
        if (q.names.length && !q.names.includes(f.name)) return false;
        if (q.contains.length && !q.contains.every((c) => f.name.includes(c))) return false;
        if (q.parents.length && !q.parents.every((pp) => (f.parents || []).includes(pp))) return false;
        if (q.trashed !== null && !!f.trashed !== q.trashed) return false;
        if (q.mime && f.mimeType !== q.mime) return false;
        return true;
      });
      const ob = u.searchParams.get("orderBy") || "";
      if (/createdTime/.test(ob)) list.sort((a, b) => (a.createdTime < b.createdTime ? -1 : a.createdTime > b.createdTime ? 1 : 0));
      if (/desc/.test(ob)) list.reverse();
      const size = Number(u.searchParams.get("pageSize") || 100);
      const start = Number(u.searchParams.get("pageToken") || 0);
      const page = list.slice(start, start + size);
      const fields = u.searchParams.get("fields") || "files(id,name)";
      const inner = (/files\(([^)]*)\)/.exec(fields) || [])[1] || "id,name";
      const out = { files: page.map((f) => metaOut(f, inner)) };
      if (start + size < list.length && /nextPageToken/.test(fields)) out.nextPageToken = String(start + size);
      return json(route, 200, out);
    }

    // メタデータだけで作る
    if (method === "POST" && p === "/drive/v3/files") {
      let meta = {};
      try { meta = JSON.parse(req.postData() || "{}"); } catch (e) {}
      const f = create(meta, Buffer.alloc(0));
      return json(route, 200, metaOut(f, u.searchParams.get("fields")));
    }

    // アップロードで作る
    if (method === "POST" && p === "/upload/drive/v3/files") {
      const type = u.searchParams.get("uploadType");
      const buf = req.postDataBuffer() || Buffer.alloc(0);
      let meta = {}, content = buf, ctype = req.headers()["content-type"];
      if (type === "multipart") {
        const parts = parseMultipart(buf, ctype);
        if (!parts || !parts.length) return err(route, 400, "bad multipart");
        try { meta = JSON.parse(parts[0].body.toString("utf8")); } catch (e) { return err(route, 400, "bad meta"); }
        content = parts[1] ? parts[1].body : Buffer.alloc(0);
        ctype = parts[1] ? parts[1].ctype : "";
      }
      if ((meta.parents || []).includes("appDataFolder") && !scopes.some((s) => /drive\.appdata$/.test(s))) return err(route, 403, "appdata scope");
      if (!(meta.parents || []).includes("appDataFolder") && !scopes.some((s) => /drive\.file$/.test(s))) return err(route, 403, "file scope");
      const f = create(meta, content, ctype);
      return json(route, 200, metaOut(f, u.searchParams.get("fields")));
    }

    if (!idm) return err(route, 404, "unknown path " + p);
    const f = files.get(decodeURIComponent(idm[1]));
    if (!f || !canSee(f, scopes)) return err(route, 404, "File not found");

    if (method === "GET") {
      if (u.searchParams.get("alt") === "media") {
        return route.fulfill({ status: 200, contentType: f.mimeType || "application/octet-stream", body: f.content });
      }
      return json(route, 200, metaOut(f, u.searchParams.get("fields")));
    }
    if (method === "DELETE") { files.delete(f.id); return route.fulfill({ status: 204, body: "" }); }
    if (method === "PATCH" && p.startsWith("/upload/")) {
      const type = u.searchParams.get("uploadType");
      const buf = req.postDataBuffer() || Buffer.alloc(0);
      if (type === "multipart") {
        const parts = parseMultipart(buf, req.headers()["content-type"]);
        if (!parts) return err(route, 400, "bad multipart");
        try { Object.assign(f, JSON.parse(parts[0].body.toString("utf8"))); } catch (e) {}
        f.content = parts[1] ? parts[1].body : Buffer.alloc(0);
      } else {
        f.content = buf;
      }
      f.modifiedTime = nowIso();
      return json(route, 200, metaOut(f, u.searchParams.get("fields")));
    }
    if (method === "PATCH") {
      let meta = {};
      try { meta = JSON.parse(req.postData() || "{}"); } catch (e) {}
      ["name", "trashed", "appProperties", "mimeType"].forEach((k) => { if (k in meta) f[k] = meta[k]; });
      f.modifiedTime = nowIso();
      return json(route, 200, metaOut(f, u.searchParams.get("fields")));
    }
    return err(route, 405, method);
  }

  return {
    files, log, handle,
    /** 名前で探す（テストの確認用） */
    byName(name) { return [...files.values()].filter((f) => f.name === name && !f.trashed); },
    text(id) { const f = files.get(id); return f ? f.content.toString("utf8") : null; },
    json(id) { const t = this.text(id); return t == null ? null : JSON.parse(t); },
    put(name, content, { parents = [], mimeType = "application/json" } = {}) {
      return create({ name, parents, mimeType }, Buffer.from(typeof content === "string" ? content : JSON.stringify(content), "utf8"));
    },
    /** 中身を外から書き換える（他端末が書いたことにする） */
    write(id, content) {
      const f = files.get(id); f.content = Buffer.from(typeof content === "string" ? content : JSON.stringify(content), "utf8"); f.modifiedTime = nowIso();
    },
    expireAll() { expired = true; },
    renew() { expired = false; },
    failNext(n, status = 500) { for (let i = 0; i < n; i++) failQueue.push(status); },
    hang(pred) { hangPred = pred; }
  };
}
