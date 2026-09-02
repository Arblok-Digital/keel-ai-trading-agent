(function () {
  const LS_KEY = "keel.proto.state";

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      const s = raw ? JSON.parse(raw) : null;
      if (!s || !ARCHETYPES[s.archetypeKey]) s = null;
      return s || { screen: "home", projectName: "kopikita-dashboard", archetypeKey: "saas-dashboard", schemaSynced: false };
    } catch (e) {
      return { screen: "home", projectName: "kopikita-dashboard", archetypeKey: "saas-dashboard", schemaSynced: false };
    }
  }

  let S = loadState();
  let genToken = 0;

  function persist() {
    try {
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          screen: S.screen === "generating" ? "viewer" : S.screen,
          projectName: S.projectName,
          archetypeKey: S.archetypeKey,
          schemaSynced: !!S.schemaSynced
        })
      );
    } catch (e) {}
  }

  const $ = (sel) => document.querySelector(sel);
  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  let toastTimer = null;
  function notify(msg) {
    clearTimeout(toastTimer);
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  function statusChip(status, driftCount) {
    if (status === "drift") return '<span class="status-chip drift">DRIFT · ' + driftCount + "</span>";
    if (status === "stale") return '<span class="status-chip stale">STALE</span>';
    return '<span class="status-chip synced">SYNCED</span>';
  }

  /* ---------------- HOME ---------------- */

  function renderHome(body) {
    body.innerHTML =
      '<header class="topbar">' +
      '<div class="logotype">KEEL<span>.</span></div>' +
      '<div class="topbar-meta"><span class="label">v0.4.1</span>' +
      '<span class="label label--faint">LOCAL · NO CLOUD</span></div></header>' +
      '<div class="home-scroll">' +
      '<section class="hero"><div class="ticks"><i></i><i></i><i></i><i></i></div>' +
      '<div class="label label--lime">00 / HULU — MULAI DI SINI</div>' +
      "<h1>Lay the keel<br>first<em>.</em></h1>" +
      '<p class="hero-sub">Ketik satu nama project. Keel membangun source of truth lengkap hulu ke hilir — konstitusi, arsitektur, kontrak API &amp; data, system prompt, sampai korpus RAG yang siap di-ingest.</p>' +
      '<div class="input-row">' +
      '<input id="sot-input" class="input-sot" placeholder="nama-project-anda" spellcheck="false" autocomplete="off">' +
      '<button id="btn-generate" class="btn btn--primary">Generate SOT ⏎</button></div>' +
      '<div id="field-error"></div>' +
      '<div class="chip-row"><span class="label label--faint" style="margin-right:4px">ARKETIPE:</span>' +
      Object.entries(ARCHETYPES)
        .map(
          ([key, a]) =>
            '<button class="chip' + (key === S.archetypeKey ? " active" : "") + '" data-key="' + key + '">' +
            esc(a.label.toUpperCase()) + "</button>"
        )
        .join("") +
      "</div>" +
      '<div class="stack-strip">OPINIONATED STACK →&nbsp;<b id="stack-text">' + esc(ARCHETYPES[S.archetypeKey].stack) + "</b></div>" +
      "</section>" +
      '<div class="phase-strip">' +
      PHASES.map(
        (p) =>
          '<div class="phase-cell"><div class="label label--faint">' + p.id + "</div><p>" + esc(p.desc) + "</p></div>"
      ).join("") +
      "</div>" +
      '<section class="recent">' +
      '<div style="display:flex;align-items:baseline;gap:12px">' +
      '<span class="label">PROJECT TERAKHIR</span>' +
      '<span class="label label--faint">STATUS SINKRONISASI REAL-TIME</span></div>' +
      '<div class="recent-list">' +
      RECENT.map(function (r) {
        return (
          '<button class="row-item" data-name="' + esc(r.name) + '" data-arch="' + esc(r.archetype) + '">' +
          statusChip(r.status, r.driftCount) +
          '<span class="row-name">' + esc(r.name) + "</span>" +
          '<div class="row-meta"><span class="label label--faint">' + esc(r.archetype.toUpperCase()) + "</span>" +
          '<span class="label">' + r.artifacts + " ARTIFACTS</span>" +
          '<span class="label label--faint">' + r.sync + "</span></div></button>"
        );
      }).join("") +
      "</div></section></div>";

    const input = $("#sot-input");
    const errBox = $("#field-error");

    function fail(msg) {
      errBox.innerHTML = '<div class="field-error">▲ ' + msg + "</div>";
      input.classList.add("invalid");
    }
    function clearErr() {
      errBox.innerHTML = "";
      input.classList.remove("invalid");
    }
    function submit() {
      const slug = input.value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      if (slug.length < 3) {
        return fail("minimal 3 karakter — contoh: toko-busana-muslim");
      }
      input.value = slug;
      clearErr();
      S.projectName = slug;
      S.screen = "generating";
      persist();
      render();
    }

    input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
    input.addEventListener("input", clearErr);
    $("#btn-generate").addEventListener("click", submit);

    body.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        S.archetypeKey = chip.dataset.key;
        body.querySelectorAll(".chip").forEach((c) => c.classList.toggle("active", c === chip));
        $("#stack-text").textContent = ARCHETYPES[S.archetypeKey].stack;
        persist();
      });
    });

    body.querySelectorAll(".row-item").forEach((row) => {
      row.addEventListener("click", () => {
        S.projectName = row.dataset.name;
        const match = Object.entries(ARCHETYPES).find(([, a]) => a.label === row.dataset.arch);
        if (match) S.archetypeKey = match[0];
        S.screen = "viewer";
        persist();
        render();
      });
    });

    setTimeout(() => input.focus(), 60);
  }

  /* ---------------- GENERATING ---------------- */

  function renderGenerating(body) {
    body.innerHTML =
      '<div class="gen"><div class="gen-head">' +
      '<span class="label label--lime">01 → 07 / GENERATING</span>' +
      "<h2>" + esc(S.projectName) + "</h2>" +
      '<span class="label mono timer" id="gen-timer" style="margin-left:auto;color:var(--lime)">0/7 · 0.0s</span>' +
      '<button id="btn-skip" class="btn btn--ghost btn--small" style="margin-left:16px">SKIP ▸</button>' +
      "</div>" +
      '<div class="gen-phases">' +
      PHASES.map(
        (p) =>
          '<div class="gen-phase" data-i="' + p.id + '"><div class="scanline"></div>' +
          '<div class="gp-index">' + p.id + "</div>" +
          '<div class="gp-body"><h3>' + esc(p.label) + "</h3><p>" + esc(p.desc) + "</p></div>" +
          '<span class="gp-count mono"></span>' +
          '<span class="gp-state">QUEUED</span></div>'
      ).join("") +
      "</div></div>";

    const rows = Array.from(body.querySelectorAll(".gen-phase"));
    const timerEl = $("#gen-timer");
    const start = Date.now();
    const token = ++genToken;

    const tickT = setInterval(() => {
      if (token !== genToken) return clearInterval(tickT);
      const e = Math.floor((Date.now() - start) / 100) / 10;
      timerEl.textContent = doneCount + "/" + PHASES.length + " · " + e.toFixed(1) + "s";
    }, 100);

    let idx = 0;
    let doneCount = 0;

    function finishToViewer() {
      if (token !== genToken) return;
      genToken++;
      clearInterval(tickT);
      S.screen = "viewer";
      persist();
      render();
    }

    $("#btn-skip").addEventListener("click", finishToViewer);

    function step() {
      if (token !== genToken) return;
      if (idx >= PHASES.length) {
        setTimeout(finishToViewer, 650);
        return;
      }
      const row = rows[idx];
      const p = PHASES[idx];
      row.classList.add("vis");
      row.classList.add("active");
      row.querySelector(".gp-state").textContent = "RUNNING…";
      row.querySelector(".gp-state").style.color = "var(--lime)";

      if (p.key === "corpus") {
        let c = 0;
        const dur = GEN_TIMINGS[idx];
        const ct = setInterval(() => {
          if (token !== genToken) return clearInterval(ct);
          c += 10;
          row.querySelector(".gp-count").textContent = Math.min(c, 128) + "/128 chunks";
        }, dur / 14);
      }

      const dur = GEN_TIMINGS[idx];
      setTimeout(() => {
        if (token !== genToken) return;
        row.classList.remove("active");
        row.classList.add("done");
        row.querySelector(".gp-state").textContent = "✓ DONE";
        row.querySelector(".gp-state").style.color = "";
        row.querySelector(".gp-count").textContent =
          p.artifacts.length + " artifact" + (p.artifacts.length > 1 ? "s" : "");
        doneCount += 1;
        idx += 1;
        step();
      }, dur);
    }

    setTimeout(step, 250);
  }

  /* ---------------- VIEWER ---------------- */

  let selectedArtifact = "constitution.md";
  let showDiff = false;
  let corpusTarget = null;

  function artifactCount() {
    return PHASES.reduce((n, p) => n + p.artifacts.length, 0);
  }

  function archFlowHTML(a) {
    return (
      '<div class="well fade-key"><div class="ticks"><i></i><i></i><i></i><i></i></div>' +
      '<div class="arch-flow">' +
      a.flow
        .map(function (n, i) {
          return (
            '<div class="arch-node"><h4>' +
            String(i + 1).padStart(2, "0") + " · " + esc(n.name) +
            '</h4><p>' + esc(n.meta) + "</p></div>" +
            (i < a.flow.length - 1 ? '<div class="arch-link"></div>' : "")
          );
        })
        .join("") +
      "</div></div>" +
      '<div class="well" style="margin-top:18px"><div class="ticks"><i></i><i></i><i></i><i></i></div><pre>' +
      a.body.split("kopikita-dashboard").join(esc(S.projectName)) +
      "</pre></div>"
    );
  }

  function renderViewer(body) {
    if (!ARTIFACTS[selectedArtifact]) selectedArtifact = "constitution.md";
    if (!corpusTarget) corpusTarget = ARTIFACTS["corpus-manifest.json"].targets[0];
    const a = ARTIFACTS[selectedArtifact];

    const railHTML =
      PHASES.map(function (p) {
        return (
          '<div class="rail-group"><div class="rail-group-label">' +
          '<span class="label label--faint">' + p.id + '</span><span class="label">' + esc(p.label.toUpperCase()) + "</span></div>" +
          p.artifacts
            .map(function (f) {
              const drifted = f === "schema.ts" && !S.schemaSynced;
              return (
                '<button class="tree-item' + (selectedArtifact === f ? " active" : "") + (drifted ? " drift" : "") +
                '" data-f="' + f + '"><span class="dot"></span><span class="name">' + f + "</span></button>"
              );
            })
            .join("") +
          "</div>"
        );
      }).join("");

    const driftedNow = a.drifted && !S.schemaSynced;

    let paneBody;
    if (selectedArtifact === "architecture.md") {
      paneBody = archFlowHTML(a);
    } else {
      const diffBtn =
        driftedNow && a.diff
          ? '<button id="btn-diff" class="btn btn--ghost btn--small" style="margin-bottom:14px">' +
            (showDiff ? "HIDE DIFF" : "VIEW DIFF") + "</button>"
          : "";
      const diffBlock =
        driftedNow && showDiff && a.diff
          ? '<div class="diff" style="margin-top:0">' +
            a.diff
              .map(
                (d) =>
                  '<div class="diff-row ' + d.kind + '"><span class="sign">' + d.sign + "</span><code>" +
                  esc(d.code) + "</code></div>"
              )
              .join("") +
            "</div>"
          : "";
      const banner = driftedNow
        ? '<div class="banner"><span class="label label--amber">▲ DRIFT</span><p>Kode berubah setelah generasi (' +
          a.driftTime + ") — " + esc(a.driftNote) +
          '. SOT tidak lagi mencerminkan kode.</p><button id="btn-resync" class="btn btn--ghost btn--small">RESYNC</button></div>'
        : "";
      const targetRow =
        selectedArtifact === "corpus-manifest.json"
          ? '<div class="target-row"><span class="label label--faint">INGEST TARGET:</span>' +
            ARTIFACTS["corpus-manifest.json"].targets
              .map(
                (t) =>
                  '<button class="chip' + (t === corpusTarget ? " active" : "") + '" data-target="' + t + '">' +
                  t.toUpperCase() + "</button>"
              )
              .join("") +
            "</div>"
          : "";
      paneBody =
        banner + diffBtn + diffBlock +
        '<div class="well fade-key"><div class="ticks"><i></i><i></i><i></i><i></i></div><pre>' +
        a.body.split("kopikita-dashboard").join(esc(S.projectName)) +
        "</pre></div>" +
        targetRow;
    }

    body.innerHTML =
      '<div class="viewer"><nav class="rail">' + railHTML + "</nav>" +
      '<main class="pane"><div class="pane-head"><div class="pane-head-row">' +
      '<button id="btn-back" class="btn btn--ghost btn--small">◂ KEEL</button>' +
      "<h2>" + esc(a.title) + "</h2>" +
      statusChip(driftedNow ? "drift" : "synced", 1) +
      '<div class="pane-actions">' +
      '<button id="btn-speckit" class="btn btn--ghost">EXPORT SPECKIT</button>' +
      '<button id="btn-agents" class="btn btn--primary btn--small" style="height:40px">⤓ AGENTS.MD</button>' +
      "</div></div>" +
      '<div class="pane-sub"><span class="row-name">' + esc(S.projectName) + "</span>" +
      '<span class="label label--faint">' + esc(ARCHETYPES[S.archetypeKey].label.toUpperCase()) + "</span>" +
      '<span class="label">GENERATED 2026-08-26 09:14</span>' +
      '<span class="label label--lime">' + artifactCount() + " ARTIFACTS</span></div>" +
      "</div>" +
      '<div class="pane-body" id="pane-body">' + paneBody + "</div></main></div>";

    body.querySelectorAll(".tree-item").forEach((item) => {
      item.addEventListener("click", () => {
        selectedArtifact = item.dataset.f;
        showDiff = false;
        renderViewer(body);
      });
    });

    const back = $("#btn-back");
    if (back)
      back.addEventListener("click", () => {
        S.screen = "home";
        persist();
        render();
      });

    const speckit = $("#btn-speckit");
    if (speckit)
      speckit.addEventListener("click", () =>
        notify(S.projectName + " — speckit bundle diekspor (7 files)")
      );

    const agents = $("#btn-agents");
    if (agents)
      agents.addEventListener("click", () => notify("AGENTS.md diunduh — siap diletakkan di root repo"));

    const resync = $("#btn-resync");
    if (resync)
      resync.addEventListener("click", () => {
        S.schemaSynced = true;
        showDiff = false;
        persist();
        renderViewer(body);
        notify("schema.ts disinkronkan — SOT " + S.projectName + " SYNCED kembali");
      });

    const diffBtn = $("#btn-diff");
    if (diffBtn)
      diffBtn.addEventListener("click", () => {
        showDiff = !showDiff;
        renderViewer(body);
      });

    body.querySelectorAll("[data-target]").forEach((chip) => {
      chip.addEventListener("click", () => {
        corpusTarget = chip.dataset.target;
        renderViewer(body);
        notify("korpus 128 chunks akan di-ingest ke " + corpusTarget);
      });
    });
  }

  /* ---------------- ROOT ---------------- */

  function render() {
    const body = $("#app-body");
    if (S.screen === "home") renderHome(body);
    else if (S.screen === "generating") renderGenerating(body);
    else renderViewer(body);
  }

  document.addEventListener("DOMContentLoaded", render);
})();
