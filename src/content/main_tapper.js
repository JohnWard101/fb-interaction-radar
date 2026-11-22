(() => {
  if (window.__FB_RADAR_MAIN_INSTALLED__) return;
  window.__FB_RADAR_MAIN_INSTALLED__ = true;

  let channelSecret = null;
  let lastReactionsReq = null;

  document.addEventListener("fb-radar:configure", (ev) => {
    if (!channelSecret && ev?.detail?.secret) {
      channelSecret = String(ev.detail.secret);
    }
  });

  function captureReactionsRequest(bodyStr) {
    try {
      const p = new URLSearchParams(bodyStr);
      const friendlyName = p.get("fb_api_req_friendly_name") || "";
      const rawVars = p.get("variables") || "";
      if (!/ReactionsList|Reactors|CometUFIReactionsDialog/i.test(friendlyName)) return;
      const parsedVars = JSON.parse(rawVars);
      const hasCursorKey = "cursor" in parsedVars || "after" in parsedVars;
      if (!lastReactionsReq || hasCursorKey) {
        lastReactionsReq = { bodyStr, friendlyName, hasCursorKey };
      }
    } catch {
      // Bỏ qua request không parse được variables
    }
  }

  function emitRawPayload(text) {
    if (!channelSecret || typeof text !== "string") return;
    // Lọc nhanh trước khi chuyển qua CustomEvent để giảm chi phí clone chuỗi
    if (
      !text.includes("reactors") &&
      !text.includes("Comment") &&
      !text.includes("reshares") &&
      !text.includes("author")
    ) {
      return;
    }
    document.dispatchEvent(
      new CustomEvent("fb-radar:graphql-chunk", {
        detail: { secret: channelSecret, rawText: text }
      })
    );
  }

  function emitRequestHint(body) {
    if (!channelSecret || !body) return;
    let bodyStr = "";
    if (typeof body === "string") bodyStr = body;
    else if (body instanceof URLSearchParams) bodyStr = body.toString();
    else if (typeof FormData !== "undefined" && body instanceof FormData) {
      const p = new URLSearchParams();
      for (const [k, v] of body.entries()) {
        if (typeof v === "string") p.append(k, v);
      }
      bodyStr = p.toString();
    }
    if (!bodyStr.includes("doc_id=")) return;
    captureReactionsRequest(bodyStr);
    document.dispatchEvent(
      new CustomEvent("fb-radar:docid-hint", {
        detail: { secret: channelSecret, body: bodyStr }
      })
    );
  }

  const origFetch = window.fetch;

  document.addEventListener("fb-radar:fetch-reactors-page", async (ev) => {
    const d = ev?.detail;
    if (!channelSecret || !d || d.secret !== channelSecret) return;
    const reply = (ok) => {
      document.dispatchEvent(
        new CustomEvent("fb-radar:fetch-reactors-page-done", {
          detail: { secret: channelSecret, requestId: d.requestId, ok }
        })
      );
    };

    if (!lastReactionsReq || !d.cursor || typeof origFetch !== "function") {
      reply(false);
      return;
    }

    try {
      const params = new URLSearchParams(lastReactionsReq.bodyStr);
      const vars = JSON.parse(params.get("variables") || "{}");
      if ("after" in vars && !("cursor" in vars)) vars.after = d.cursor;
      else vars.cursor = d.cursor;
      params.set("variables", JSON.stringify(vars));

      const res = await origFetch("https://www.facebook.com/api/graphql/", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-FB-Friendly-Name": lastReactionsReq.friendlyName || "CometUFIReactionsDialogTabContentRefetchQuery"
        },
        body: params.toString()
      });
      if (!res.ok) {
        reply(false);
        return;
      }
      const rawText = await res.text();
      emitRawPayload(rawText);
      reply(true);
    } catch {
      reply(false);
    }
  });
  if (typeof origFetch === "function") {
    window.fetch = async function (...args) {
      const response = await origFetch.apply(this, args);
      try {
        const reqUrl = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
        if (reqUrl.includes("/api/graphql")) {
          const reqBody = args[1]?.body;
          if (typeof reqBody === "string") emitRequestHint(reqBody);
          else if (reqBody instanceof URLSearchParams) emitRequestHint(reqBody.toString());
          response.clone().text().then(emitRawPayload).catch(() => {});
        }
      } catch {
        // Không bao giờ làm hỏng fetch gốc của Facebook
      }
      return response;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__fbRadarUrl = typeof url === "string" ? url : "";
    return origOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__fbRadarUrl && this.__fbRadarUrl.includes("/api/graphql")) {
      if (typeof args[0] === "string") emitRequestHint(args[0]);
      else if (args[0] instanceof URLSearchParams) emitRequestHint(args[0].toString());
      this.addEventListener("load", () => {
        try {
          if (typeof this.responseText === "string") {
            emitRawPayload(this.responseText);
          }
        } catch {
          // Bỏ qua lỗi đọc XHR
        }
      });
    }
    return origSend.apply(this, args);
  };
})();