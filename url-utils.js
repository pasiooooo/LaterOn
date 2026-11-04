// Shared URL canonicalization for matching the active tab with saved items.
(function () {
  function normalize(url) {
    try {
      const parsed = new URL(url);
      // 同一 YouTube 视频可能来自稍后观看、播放列表、短链接或移动端。
      // 用视频 ID 匹配；保留原始网址用于实际打开，不改变播放时间或列表。
      const hostname = parsed.hostname.toLowerCase();
      const youtube = ["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(hostname);
      let videoId = "";
      if (["http:", "https:"].includes(parsed.protocol) && !parsed.port) {
        if (["youtu.be", "www.youtu.be"].includes(hostname)) {
          videoId = parsed.pathname.match(/^\/([^/]+)\/?$/)?.[1] || "";
        } else if (youtube) {
          videoId = /^\/watch\/?$/.test(parsed.pathname)
            ? parsed.searchParams.get("v") || ""
            : parsed.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)\/?$/)?.[1] || "";
        }
      }
      if (/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
        return `https://youtube.com/watch?v=${videoId}`;
      }
      const host = parsed.host.toLowerCase().replace(/^www\./, "");
      const path = parsed.pathname.replace(/\/+$/, "") || "/";
      const keep = [...parsed.searchParams.entries()]
        .filter(([key]) => !/^(utm_|fbclid|gclid|mc_|ref|spm|igshid)/i.test(key))
        .sort(([a], [b]) => a.localeCompare(b));
      const search = keep.length
        ? "?" + keep.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")
        : "";
      return `${parsed.protocol}//${host}${path}${search}`;
    } catch {
      return String(url || "").trim().toLowerCase();
    }
  }

  // Search pages often publish only "Search Results" in sharing metadata. The
  // query in a recognized engine's result URL remains correct after SPA updates.
  function searchTitle(value) {
    try {
      const url = new URL(value);
      if (!/^https?:$/.test(url.protocol)) return "";
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      const route = url.pathname.replace(/\/+$/, "") || "/";
      let engine = "", keys = [];
      // Use exact country suffixes, not a permissive google.* pattern, which
      // would also recognize unrelated domains such as google.example.com.
      const google = /^google\.(?:com|cn|de|fr|es|it|nl|be|at|ch|se|no|dk|fi|pl|pt|ie|cz|gr|hu|ro|sk|tr|ca|ru|cl|co\.uk|com\.au|co\.nz|co\.jp|co\.kr|com\.hk|com\.tw|com\.sg|com\.my|co\.in|co\.id|co\.th|com\.vn|com\.br|com\.mx|com\.ar|com\.co|co\.za|com\.tr|com\.sa|ae|co\.il)$/;
      if (google.test(host) && ["/", "/search", "/webhp"].includes(route)) {
        engine = "Google"; keys = ["q"];
      } else if (["bing.com", "cn.bing.com", "bing.cn"].includes(host) && route === "/search") {
        engine = "Bing"; keys = ["q"];
      } else if (["baidu.com", "m.baidu.com"].includes(host) && route === "/s") {
        engine = "百度"; keys = ["wd", "word"];
      } else if (["duckduckgo.com", "html.duckduckgo.com", "lite.duckduckgo.com"].includes(host) && ["/", "/html", "/lite"].includes(route)) {
        engine = "DuckDuckGo"; keys = ["q"];
      } else if ((host === "search.yahoo.com" || host.endsWith(".search.yahoo.com")) && route === "/search") {
        engine = "Yahoo"; keys = ["p"];
      } else if (["sogou.com", "m.sogou.com"].includes(host) && ["/web", "/web/searchList.jsp"].includes(route)) {
        engine = "搜狗"; keys = ["query", "keyword"];
      } else if (["so.com", "m.so.com"].includes(host) && route === "/s") {
        engine = "360搜索"; keys = ["q"];
      } else if (host === "search.brave.com" && route === "/search") {
        engine = "Brave Search"; keys = ["q"];
      } else if (["yandex.com", "yandex.ru"].includes(host) && route === "/search") {
        engine = "Yandex"; keys = ["text"];
      } else if (host === "startpage.com" && ["/sp/search", "/do/search", "/do/dsearch"].includes(route)) {
        engine = "Startpage"; keys = ["query", "q"];
      }
      if (!engine) return "";
      const query = keys.map(key => String(url.searchParams.get(key) || "").replace(/[\s\u0000-\u001f\u007f]+/g, " ").trim()).find(Boolean);
      if (!query) return "";
      return `${query.length > 260 ? query.slice(0, 260).trim() + "…" : query} - ${engine}`;
    } catch {
      return "";
    }
  }

  globalThis.LaterOnUrl = { normalize, searchTitle };
})();
