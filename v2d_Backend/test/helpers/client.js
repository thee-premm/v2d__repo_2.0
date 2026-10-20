/**
 * Minimal browser-like HTTP client for tests: keeps cookies, sends the CSRF
 * header the way the frontend does, and returns { status, body, headers }.
 */
export class TestClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookies = new Map();
    this.csrfToken = null;
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  storeCookies(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a.trim())) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method, path, body, { headers = {}, csrf = true } = {}) {
    const h = { ...headers };
    if (this.cookies.size) h.cookie = this.cookieHeader();
    if (body !== undefined) h["content-type"] = "application/json";
    if (csrf && this.csrfToken && method !== "GET") h["x-csrf-token"] = this.csrfToken;
    const res = await fetch(`${this.baseUrl}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    this.storeCookies(res);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    return { status: res.status, body: json, headers: res.headers, text };
  }

  get(path, opts) {
    return this.request("GET", path, undefined, opts);
  }
  post(path, body = {}, opts) {
    return this.request("POST", path, body, opts);
  }
  put(path, body = {}, opts) {
    return this.request("PUT", path, body, opts);
  }
  patch(path, body = {}, opts) {
    return this.request("PATCH", path, body, opts);
  }
  delete(path, body, opts) {
    return this.request("DELETE", path, body, opts);
  }

  async login(identifier, password, role) {
    const res = await this.post("/api/v1/auth/login", { identifier, password, ...(role ? { role } : {}) });
    if (res.status === 200) this.csrfToken = res.body.data.csrfToken;
    return res;
  }
}
