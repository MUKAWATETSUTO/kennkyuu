(function () {
  "use strict";
  const CFG = window.APP_CONFIG, AXES = window.AXES, JOBS = window.JOBS;
  const $app = document.getElementById("app");
  const TEST_MODE = !CFG.ENDPOINT;
  if (TEST_MODE) document.getElementById("testBadge").hidden = false;

  // ---------- 設問の形式（固定15問／固定10問／変動式）：グループと回数で決まる ----------
  // 表示順は A1,B1,C1,D1,E1,A2,... と軸を交互にする（10問版は15問版の先頭10問と同じ）
  // グループ（A〜F）：回答者コードを入力した時点で自動で決める（assignGroup）。組み合わせは config.js の MODE_BY_GROUP
  //   1回目：スプレッドシート側で、いちばん人数の少ないグループに割り当てる
  //   2回目：同じ回答者コードの1回目と同じグループにする（メモ不要）
  //   URLに ?g=A〜F を付けたときだけは、そのグループに固定する（自分で試すとき用）
  const gParam = (new URLSearchParams(location.search).get("g") || "").toUpperCase();
  const URL_GROUP = CFG.MODE_BY_GROUP[gParam] ? gParam : "";
  // 結果の説明文の方式と順番（?t=）：
  //   FV → 固定式の結果に答えたあと、同じ回答のまま変動式の結果を見せてもう一度答える
  //   VF → その逆の順番 ／ F・V → どちらか1つだけ ／ 指定なし → DEFAULT_RESULT_ORDER
  const ORDERS = { FV: ["fixed", "variable"], VF: ["variable", "fixed"], F: ["fixed"], V: ["variable"] };
  const tParam = (new URLSearchParams(location.search).get("t") || "").toUpperCase();
  const ORDER_CODE = ORDERS[tParam] ? tParam : (ORDERS[CFG.DEFAULT_RESULT_ORDER] ? CFG.DEFAULT_RESULT_ORDER : "FV");
  const ORDER = ORDERS[ORDER_CODE];
  let stage = 0; // いま何番目の結果を表示しているか（0 = 1つ目）
  const isFixed = () => ORDER[stage] === "fixed";
  let QS = [], MODE = "";
  const ADAPTIVE = () => MODE === "adaptive";
  // グループを決める。戻り値はグループ名。rec.group_source に決め方を残す
  //   url＝URLで指定 / server＝スプレッドシートで割り当て（new＝新規, found＝1回目と同じ, notfound＝2回目なのに1回目が見つからず新規）
  //   hash＝通信できなかったので回答者コードから計算（同じコードなら必ず同じグループになる）
  async function assignGroup() {
    if (URL_GROUP) { rec.group_source = "url"; return URL_GROUP; }
    const groups = Object.keys(CFG.MODE_BY_GROUP);
    const byHash = () => {
      let h = 0; for (const ch of rec.respondent_id) h = (h * 31 + ch.codePointAt(0)) % 100003;
      return groups[h % groups.length];
    };
    if (!TEST_MODE) {
      try {
        const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 10000);
        const url = `${CFG.ENDPOINT}?action=assign&code=${encodeURIComponent(rec.respondent_id)}&round=${rec.round}&groups=${groups.join("")}`;
        const res = await fetch(url, { signal: ctl.signal }); clearTimeout(timer);
        const j = JSON.parse(await res.text());
        if (j && CFG.MODE_BY_GROUP[j.group]) { rec.group_source = "server_" + j.how; return j.group; }
      } catch (e) { /* 通信できないときは下の計算で決める */ }
    }
    rec.group_source = "hash";
    return byHash();
  }

  function setRound(round) { rec.round = round; }
  // グループと回数から設問の形式を決めて、最初の問題を用意する
  function setMode(group) {
    const round = rec.round;
    rec.group = group;
    MODE = CFG.MODE_BY_GROUP[group][round];
    rec.q_mode = MODE;
    // 固定15問は各軸3問、固定10問は各軸2問。変動式は最初の1問（A1）から始め、1問ずつ次を決める（10問目までは固定10問と同じ）
    const perAxis = MODE === "fixed15" ? 3 : 2;
    QS = [];
    if (ADAPTIVE()) QS = [qById("A1")];
    else for (let n = 1; n <= perAxis; n++) AXES.forEach(a => QS.push(qById(a.key + n)));
    // 設問数：変動式は1問ずつ決めるので、途中でやめた人も形式が分かるよう最大の問題数を入れておく（完了時に実際の数で上書き）
    rec.version = ADAPTIVE() ? ((CFG.ADAPTIVE || {}).MAX || 15) : QS.length;
  }
  const qById = id => window.QUESTIONS.find(q => q.id === id);
  // 軸ごとのストック（A1〜A6 のように番号順）
  const bankOf = key => window.QUESTIONS.filter(q => q.axis === key).sort((x, y) => Number(x.id.slice(1)) - Number(y.id.slice(1)));
  // 答え（1〜5）を軸の向きにそろえた値（-2〜+2）に直す
  const itemVal = q => (answers[q.id] - 3) * (q.rev ? -1 : 1);

  // 変動式の問題数の表示（MIN と MAX が同じなら「15」、違えば「10〜15」）
  const adaptiveLabel = () => {
    const C = Object.assign({ MIN: 10, MAX: 15 }, CFG.ADAPTIVE || {});
    return C.MIN === C.MAX ? String(C.MAX) : `${C.MIN}〜${C.MAX}`;
  };

  // 変動式で出した問題の記録：順番（adaptive_path）、10問を超えた数、軸ごとの問題数
  function recordAdaptive() {
    const asked = QS.filter(q => answers[q.id] != null);
    rec.adaptive_path = asked.map(q => q.id).join(",");
    rec.adaptive_extra = Math.max(0, asked.length - 10);
    rec.adaptive_axes = AXES.map(a => a.key + ":" + asked.filter(q => q.axis === a.key).length).join(" ");
  }

  // ---------- 変動式：次に出す問題を決める（null なら終了） ----------
  function nextAdaptive() {
    const C = Object.assign({ FIRST: 2, MIN: 10, MAX: 15, STOP_GAP: 15 }, CFG.ADAPTIVE || {});
    const asked = QS.filter(q => answers[q.id] != null);
    const n = asked.length;
    // 1) まず全員同じ問題：各軸の1〜FIRST問目を A1,B1,C1,D1,E1,A2,…,E2 の順に出す（固定10問と同じ問題・同じ順番）
    for (let r = 1; r <= C.FIRST; r++) {
      const q = AXES.map(a => qById(a.key + r)).find(x => x && answers[x.id] == null);
      if (q) return q;
    }
    if (n >= C.MAX) return null;
    // 3) 終了判定：MIN問以上答えて、1位と2位の差が十分にひらいたら終わる
    const now = score(asked);
    const gap = now.ranked[0].match - now.ranked[1].match;
    if (n >= C.MIN && gap >= C.STOP_GAP) return null;
    // 2) 次に聞く軸を選ぶ
    const p1 = now.ranked[0].job.p, p2 = now.ranked[1].job.p;
    let best = null, bestScore = -1;
    AXES.forEach((a, k) => {
      const rest = bankOf(a.key).filter(q => answers[q.id] == null && !QS.includes(q));
      if (!rest.length) return;
      const vals = asked.filter(q => q.axis === a.key).map(itemVal);
      const mean = vals.reduce((x, y) => x + y, 0) / vals.length;
      const discriminate = Math.abs(p1[k] - p2[k]);                    // 1位と2位を見分けるのに効く軸ほど大きい（0〜2.4）
      const unclear = 1 - Math.min(Math.abs(mean), 1.5) / 1.5;         // 真ん中寄りほど大きい（0〜1）
      const conflict = (Math.max(...vals) - Math.min(...vals)) / 4;    // 答えが矛盾しているほど大きい（0〜1）
      const few = 1 / vals.length;                                     // 聞いた数が少ないほど大きい
      const s = (0.5 + discriminate) * (unclear + conflict + few);
      if (s > bestScore) { bestScore = s; best = rest[0]; }
    });
    return best;
  }
  const ALL_IDS = window.QUESTIONS.map(q => q.id);

  // ---------- 回答者コード ----------
  // 「出身小学校の名前の最初の1文字（ひらがな）」「兄弟姉妹の数」「誕生月」から作る。例：さ-2-07
  // 毎回同じ答えになるので、1回目と2回目を紐付けられる。
  function normalizeKana(s) {
    const c = s.trim().normalize("NFKC").charAt(0)
      .replace(/[ァ-ヶ]/, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60)); // カタカナ→ひらがな
    return /^[ぁ-ゖ]$/.test(c) ? c : null;
  }
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  // ---------- 記録（1セッション＝1行） ----------
  const now = () => new Date().toISOString();
  const rec = {
    session_id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2),
    respondent_id: "", group: "", group_source: "", round: "", q_mode: "", version: "", adaptive_extra: "", adaptive_axes: "", adaptive_path: "",
    result_order: ORDER_CODE, result_type: ORDER[0],
    status: "started", last_step: "consent", completed: 0,
    started_at: now(), consent_at: "", completed_at: "", total_sec: "",
    device: /Mobi|Android|iPhone/i.test(navigator.userAgent) ? "mobile" : "desktop",
    attr_field: "", attr_it_major: "", attr_prog: "", attr_dev: "", attr_intern: "",
    attr_cert_ip: "", attr_cert_fe: "", attr_cert_ap: "", attr_cert_other: "", attr_cert_none: "",
  };
  ALL_IDS.forEach(id => { rec["q_" + id] = ""; });
  ALL_IDS.forEach(id => { rec["t_" + id] = ""; });
  Object.assign(rec, {
    questions_sec: "", n_changes: 0, n_back: 0, max_streak: "", same_ratio: "",
  });
  AXES.forEach(a => { rec["score_" + a.key] = ""; });
  Object.assign(rec, {
    top1_job: "", top1_match: "", top2_job: "", top2_match: "", top3_job: "", top3_match: "",
    persona_type: "", persona_levels: "", persona_levels_self: "", persona_match_axes: "",
    result_view_sec: "",
    sat_overall: "", sat_accurate: "", sat_insight: "", sat_useful: "",
    fit_job: "", fit_rank: "", fit_match: "", free_text: "", free_text_len: "",
  });
  // 2つ目の結果（?t=FV / VF のときだけ値が入る）
  Object.assign(rec, {
    result_type2: ORDER[1] || "", persona2_type: "", persona2_levels: "", persona2_match_axes: "",
    result2_view_sec: "",
    sat2_overall: "", sat2_accurate: "", sat2_insight: "", sat2_useful: "",
    fit2_job: "", fit2_rank: "", fit2_match: "", free_text2: "", free_text2_len: "",
    pref: "", pref_type: "", // どちらの説明がしっくりきたか（1=1つ目 2=2つ目 0=同じくらい）とその方式
  });
  // 15問版のときだけ値が入る（10問版の行は空欄）
  AXES.forEach(a => { rec["sim10_score_" + a.key] = ""; });
  Object.assign(rec, {
    sim10_top1_job: "", sim10_top1_match: "", sim10_top2_job: "", sim10_top2_match: "", sim10_top3_job: "", sim10_top3_match: "",
    sim10_same_top1: "", sim10_top3_overlap: "", sim10_max_streak: "", sim10_questions_sec: "",
  });
  const t0 = Date.now();

  function send(useBeacon) {
    // 途中でやめた人を記録しない設定なら、送信（完了）するまで何も保存しない
    if (!rec.completed && !CFG.RECORD_DROPOUTS) return;
    rec.updated_at = now();
    const body = JSON.stringify(rec);
    if (TEST_MODE) {
      let all = {}; try { all = JSON.parse(store.get("sier_test_rows") || "{}"); } catch (e) {}
      all[rec.session_id] = JSON.parse(body); store.set("sier_test_rows", JSON.stringify(all));
      return;
    }
    if (useBeacon && navigator.sendBeacon) { navigator.sendBeacon(CFG.ENDPOINT, new Blob([body], { type: "text/plain" })); return; }
    fetch(CFG.ENDPOINT, { method: "POST", mode: "no-cors", keepalive: true, headers: { "Content-Type": "text/plain" }, body }).catch(() => {});
  }
  // 画面を閉じた・切り替えたときに最新状態を送る（途中離脱の把握用）
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && !rec.completed) send(true); });

  function step(name, status) { rec.last_step = name; if (status) rec.status = status; send(); }

  // ---------- 描画ヘルパ ----------
  // 各画面は .screen で包み、<div class="actions"> 以降が下部固定ボタンになる
  function h(html) { $app.innerHTML = `<section class="screen">${html}</section>`; window.scrollTo(0, 0); }
  function progress(p) {
    document.getElementById("progressWrap").hidden = p == null;
    document.getElementById("progressFill").style.width = (p || 0) * 100 + "%";
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- 1. 同意 ----------
  function viewConsent() {
    progress(null);
    h(`
      <div class="hero">
        <div class="hero-icon">🧭</div>
        <h1>あなたに向いている<br>SIerの職種がわかる</h1>
        <p>かんたんな質問に答えるだけで、${JOBS.length}つの職種から相性のよい職種を診断します。</p>
        <div class="chips"><span class="chip">⏱ 約3〜5分</span><span class="chip">🔒 匿名</span><span class="chip">💼 ${JOBS.length}職種</span></div>
      </div>
      <h2>SIerにはこんな職種があります</h2>
      <p class="sub" style="margin-top:0">タップすると説明が開きます。</p>
      <div class="intro-list">
        ${JOBS.map(j => {
          const t = (window.JOB_INTRO || {})[j.id] || {};
          return `<details class="intro">
            <summary><span class="ic">${j.icon}</span><span class="txt"><b>${j.name}</b><span class="sub">${t.short || ""}</span></span><span class="chev">›</span></summary>
            <div class="body">
              <p>${t.about || j.desc}</p>
              ${t.example ? `<div class="ex"><b>たとえば…</b>${t.example}</div>` : ""}
              ${t.person ? `<div class="ex"><b>こんな人に向いている</b><ul class="person">${t.person.map(p => `<li>${p}</li>`).join("")}</ul></div>` : ""}
            </div>
          </details>`;
        }).join("")}
      </div>
      <div class="grow"></div>
      <div class="actions">
        <button class="btn" id="go">診断をはじめる</button>
        <details class="consent">
          <summary>回答は卒業研究に匿名で使用します。「はじめる」を押すと同意したものとします。<u>詳しく</u></summary>
          <ul>
            <li>氏名・メールアドレスなどの個人情報は集めません。</li>
            <li>回答内容・回答時間・途中でやめたかどうかを記録し、統計的に分析します。</li>
            <li>1回目と2回目を結びつけるため、「小学校名の最初の1文字・兄弟姉妹の数・誕生月」から作るコードを使います。</li>
            <li>回答は研究以外には使いません。</li>
            <li>4年生の夏に、もう一度回答をお願いする予定です。</li>
            <li>参加は自由です。途中でやめても不利益はありません。</li>
          </ul>
        </details>
      </div>
    `);
    const go = document.getElementById("go");
    go.onclick = () => { rec.consent_at = now(); step("round", "in_progress"); viewRound(); };
  }

  // ---------- 2. 1回目 / 2回目 ----------
  function viewRound() {
    h(`
      <h1>この診断を受けるのは<br>何回目ですか？</h1>
      <p class="sub">4年生の夏に2回目をお願いしています。</p>
      <div class="opts" style="margin-top:12px">
        <button class="opt" id="r1"><span><b>はじめて</b>（1回目）</span></button>
        <button class="opt" id="r2"><span><b>2回目</b></span></button>
      </div>
    `);
    document.getElementById("r1").onclick = () => { setRound(1); step("code"); viewCode(); };
    document.getElementById("r2").onclick = () => { setRound(2); step("code"); viewCode(); };
  }

  function viewCode() {
    const sib = ["0人", "1人", "2人", "3人", "4人", "5人以上"];
    h(`
      <h1>あなた専用のコードを作ります</h1>
      <p class="sub">1回目と2回目の回答を結びつけるために使います。2回目も同じように答えてください。</p>

      <div class="card example">
        <div class="ex-title">💡 例</div>
        <p style="margin:0">「<b>さくら</b>小学校」出身・<b>兄と妹がいる</b>・<b>7月</b>生まれ の場合</p>
        <div class="ex-code">さ ‐ 2 ‐ 07</div>
      </div>

      <div class="field"><div class="q">① 出身小学校の名前の、最初の1文字</div>
        <p class="sub" style="margin-top:0">ひらがなで1文字。「さくら小学校」なら「さ」、「東小学校」なら「ひ」</p>
        <input type="text" id="kana" placeholder="例：さ" maxlength="2" autocomplete="off" style="max-width:120px;text-align:center;font-size:22px;font-weight:800">
        <p class="err" id="kanaErr"></p>
      </div>

      <div class="field"><div class="q">② 兄弟姉妹の人数（自分は数えない）</div>
        <p class="sub" style="margin-top:0">兄と妹がいる → 2人 ／ ひとりっ子 → 0人</p>
        <div class="grid3">${sib.map((s, i) => `<button class="opt" data-sib="${i}">${s}</button>`).join("")}</div>
      </div>

      <div class="field"><div class="q">③ 自分の誕生月</div>
        <div class="grid4">${Array.from({ length: 12 }, (_, i) => `<button class="opt" data-m="${i + 1}">${i + 1}月</button>`).join("")}</div>
      </div>

      <div class="card preview" id="preview" hidden>あなたのコード：<b id="codeOut"></b></div>
      <div class="actions"><button class="btn" id="go" disabled>次へ</button></div>
    `);
    const kana = document.getElementById("kana"), go = document.getElementById("go"), err = document.getElementById("kanaErr");
    const v = { kana: null, sib: null, m: null };
    const update = () => {
      v.kana = normalizeKana(kana.value);
      err.textContent = kana.value.trim() && !v.kana ? "ひらがな1文字で入力してください。" : "";
      const ok = v.kana && v.sib !== null && v.m !== null;
      go.disabled = !ok;
      document.getElementById("preview").hidden = !ok;
      if (ok) document.getElementById("codeOut").textContent = `${v.kana}-${v.sib}-${String(v.m).padStart(2, "0")}`;
    };
    kana.oninput = update;
    const pick = (attr, key) => $app.querySelectorAll(`[data-${attr}]`).forEach(b => b.onclick = () => {
      $app.querySelectorAll(`[data-${attr}]`).forEach(x => x.classList.remove("on"));
      b.classList.add("on"); v[key] = Number(b.dataset[attr]); update();
    });
    pick("sib", "sib"); pick("m", "m");
    go.onclick = () => {
      rec.respondent_id = document.getElementById("codeOut").textContent;
      go.disabled = true; go.textContent = "準備しています…";
      assignGroup().then(g => { setMode(g); step("attributes"); viewAttributes(); });
    };
  }

  // ---------- 3. 属性 ----------
  const ATTRS = [
    { key: "attr_field", q: "所属の分野", opts: ["文系", "理系（情報系以外）", "情報系", "その他"] },
    { key: "attr_prog", q: "プログラミング経験", opts: ["なし", "授業で少し触れた程度", "自主学習で半年未満", "半年〜1年", "1年以上"] },
    { key: "attr_dev", q: "アプリやWebサイトを自分（またはチーム）で完成させたことがある", opts: ["ない", "ある"] },
    { key: "attr_intern", q: "IT企業のインターンシップ参加回数", opts: ["0回", "1回", "2〜3回", "4回以上"] },
  ];
  const CERTS = [
    ["attr_cert_ip", "ITパスポート"], ["attr_cert_fe", "基本情報技術者"], ["attr_cert_ap", "応用情報技術者 以上"],
    ["attr_cert_other", "その他のIT系資格（CCNA・LPIC・AWS 等）"], ["attr_cert_none", "持っていない"],
  ];
  function viewAttributes() {
    progress(0);
    h(`
      <h1>あなたについて<br>教えてください</h1>
      <p class="sub">分析のためだけに使います。個人は特定されません。</p>
      ${ATTRS.map(a => `
        <div class="field"><div class="q">${a.q}</div>
          <div class="opts">${a.opts.map((o, i) => `<button class="opt" data-k="${a.key}" data-v="${i + 1}">${o}</button>`).join("")}</div>
        </div>`).join("")}
      <div class="field"><div class="q">持っている資格（あてはまるものすべて）</div>
        ${CERTS.map(([k, l]) => `<label class="check"><input type="checkbox" data-cert="${k}"> ${l}</label>`).join("")}
      </div>
      <div class="actions"><button class="btn" id="go" disabled>診断をはじめる（${ADAPTIVE() ? adaptiveLabel() : QS.length}問）</button></div>
    `);
    const go = document.getElementById("go");
    const vals = {};
    const certs = [...$app.querySelectorAll("[data-cert]")];
    const validate = () => { go.disabled = !(ATTRS.every(a => vals[a.key]) && certs.some(c => c.checked)); };
    $app.querySelectorAll(".opt").forEach(b => b.onclick = () => {
      $app.querySelectorAll(`.opt[data-k="${b.dataset.k}"]`).forEach(x => x.classList.remove("on"));
      b.classList.add("on"); vals[b.dataset.k] = Number(b.dataset.v); validate();
    });
    certs.forEach(c => c.onchange = () => {
      if (c.dataset.cert === "attr_cert_none" && c.checked) certs.forEach(x => { if (x !== c) x.checked = false; });
      else if (c.checked) certs.find(x => x.dataset.cert === "attr_cert_none").checked = false;
      validate();
    });
    go.onclick = () => {
      Object.assign(rec, vals);
      certs.forEach(c => { rec[c.dataset.cert] = c.checked ? 1 : 0; });
      qStart = Date.now(); viewQuestion(0);
    };
  }

  // ---------- 4. 設問 ----------
  const answers = {}, timeMs = {};
  let qStart = 0, shownAt = 0;
  function viewQuestion(i) {
    progress(i / (ADAPTIVE() ? ((CFG.ADAPTIVE || {}).MAX || 15) : QS.length));
    const q = QS[i];
    rec.last_step = "q" + (i + 1);
    shownAt = Date.now();
    h(`
      <div class="qhead"><span class="n">Q${i + 1}</span><span class="of">/ ${ADAPTIVE() ? adaptiveLabel() : QS.length}</span></div>
      <p class="sub" style="margin-top:0">どちらのほうが自分に近いですか？</p>
      <div class="pair">
        <div class="stmt"><span class="tag">A</span><span>${q.top}</span></div>
        <div class="vs">VS</div>
        <div class="stmt b"><span class="tag">B</span><span>${q.bottom}</span></div>
      </div>
      <div class="scale">${[1, 2, 3, 4, 5].map(v => `<button class="dot s${v}${answers[q.id] === v ? " on" : ""}" data-v="${v}" aria-label="${["Aに近い", "ややAに近い", "どちらとも言えない", "ややBに近い", "Bに近い"][v - 1]}"></button>`).join("")}</div>
      <div class="scale-labels"><span class="l">← Aに近い</span><span>どちらとも</span><span class="r">Bに近い →</span></div>
      <p class="hint">丸をタップすると次の質問に進みます</p>
      <div class="grow"></div>
      <div class="actions">${i > 0 ? `<button class="btn link" id="back">← 前の質問に戻る</button>` : ""}</div>
    `);
    const leave = () => { timeMs[q.id] = (timeMs[q.id] || 0) + (Date.now() - shownAt); };
    $app.querySelectorAll(".dot").forEach(b => b.onclick = () => {
      const v = Number(b.dataset.v);
      const prev = answers[q.id];
      if (prev && prev !== v) rec.n_changes++;
      answers[q.id] = v;
      $app.querySelectorAll(".dot").forEach(x => x.classList.toggle("on", x === b));
      $app.querySelectorAll(".dot").forEach(x => { x.disabled = true; });
      leave();
      rec["q_" + q.id] = v; rec["t_" + q.id] = +(timeMs[q.id] / 1000).toFixed(2);
      setTimeout(() => {
        if (ADAPTIVE()) {
          // 変動式：答えを変えたら、その先の問題は選び直す（先に答えていた分は取り消す）
          if (!(prev === v && i + 1 < QS.length)) {
            QS.slice(i + 1).forEach(x => { delete answers[x.id]; delete timeMs[x.id]; rec["q_" + x.id] = ""; rec["t_" + x.id] = ""; });
            QS = QS.slice(0, i + 1);
            const nx = nextAdaptive();
            if (nx) QS.push(nx);
          }
          recordAdaptive();
        }
        if (i + 1 < QS.length) { send(); viewQuestion(i + 1); } else finishQuestions();
      }, 220);
    });
    const back = document.getElementById("back");
    if (back) back.onclick = () => { leave(); rec.n_back++; viewQuestion(i - 1); };
  }

  // ---------- 採点 ----------
  // qs：採点に使う設問（15問版の人を「10問だけで採点したら？」と再計算するときは先頭10問を渡す）
  function score(qs) {
    const s = {};
    AXES.forEach(a => {
      const items = qs.filter(q => q.axis === a.key);
      // 回答 1〜5 → -2〜+2（下の文=B寄りが+）。逆転項目は符号を反転
      const vals = items.map(q => (answers[q.id] - 3) * (q.rev ? -1 : 1));
      s[a.key] = vals.reduce((x, y) => x + y, 0) / vals.length;
    });
    const u = AXES.map(a => s[a.key]);
    // 相性% = 100 × exp(−d² / (2σ²))。d は5軸スコアと職種プロファイルの距離。
    // 近い職種ほど急に高くなるので、1位と2位の差がはっきり出る（順位は距離の近い順のまま）
    const sigma = CFG.MATCH_SIGMA || 2;
    const ranked = JOBS.map(j => {
      const d2 = j.p.reduce((acc, p, k) => acc + (u[k] - p) ** 2, 0);
      return { job: j, d2, match: Math.round(100 * Math.exp(-d2 / (2 * sigma * sigma))) };
    }).sort((a, b) => a.d2 - b.d2);
    return { axis: s, ranked };
  }

  let result = null, resultShownAt = 0;
  function finishQuestions() {
    rec.questions_sec = +((Date.now() - qStart) / 1000).toFixed(1);
    // 同じ選択肢の最大連続回数（表示順）と、最頻値の割合
    const seq = QS.map(q => answers[q.id]);
    let max = 1, cur = 1;
    for (let k = 1; k < seq.length; k++) { cur = seq[k] === seq[k - 1] ? cur + 1 : 1; if (cur > max) max = cur; }
    const freq = {}; seq.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
    rec.max_streak = max; rec.same_ratio = +(Math.max(...Object.values(freq)) / seq.length).toFixed(3);

    result = score(QS);
    AXES.forEach(a => { rec["score_" + a.key] = +result.axis[a.key].toFixed(3); });
    result.ranked.slice(0, 3).forEach((r, k) => { rec[`top${k + 1}_job`] = r.job.id; rec[`top${k + 1}_match`] = r.match; });
    recordPersona();

    rec.version = QS.length; // 実際に答えた設問数
    // 10問より多く答えた人（固定15問・3問目を追加した変動式）は、同じ回答を最初の10問（各軸1・2問目）だけで
    // 採点し直した結果も残す。同じ人・同じ時点のデータで「設問を減らすと結果がどれだけ変わるか」を比べられる
    if (QS.length > 10) {
      const first10 = QS.slice(0, 10);
      const sim = score(first10);
      AXES.forEach(a => { rec["sim10_score_" + a.key] = +sim.axis[a.key].toFixed(3); });
      sim.ranked.slice(0, 3).forEach((r, k) => { rec[`sim10_top${k + 1}_job`] = r.job.id; rec[`sim10_top${k + 1}_match`] = r.match; });
      rec.sim10_same_top1 = sim.ranked[0].job.id === result.ranked[0].job.id ? 1 : 0;
      const top3 = result.ranked.slice(0, 3).map(r => r.job.id);
      rec.sim10_top3_overlap = sim.ranked.slice(0, 3).filter(r => top3.includes(r.job.id)).length; // 0〜3
      const seq10 = first10.map(q => answers[q.id]);
      let m10 = 1, c10 = 1;
      for (let k = 1; k < seq10.length; k++) { c10 = seq10[k] === seq10[k - 1] ? c10 + 1 : 1; if (c10 > m10) m10 = c10; }
      rec.sim10_max_streak = m10; // 10問版の max_streak と同じ条件で比べるための値
      rec.sim10_questions_sec = +first10.reduce((acc, q) => acc + (timeMs[q.id] || 0) / 1000, 0).toFixed(1);
    }
    step("result");
    viewResult();
  }

  // いま表示する説明文の種類（persona_type / persona_levels）と、本人のスコアならどうなるか（_self）を記録する。
  // 固定式で、見せた文章が本人とどれだけ食い違っていたかを分析で確かめられるようにするため
  function recordPersona() {
    const shown = personality(textAxis(result.ranked.slice(0, 3))), self = personality(result.axis);
    const p = stage === 0 ? "persona" : "persona2";
    rec[p + "_type"] = shown.typeCode; rec[p + "_levels"] = shown.levels;
    rec[p + "_match_axes"] = AXES.filter((a, i) => shown.levels.split(" ")[i] === self.levels.split(" ")[i]).length; // 0〜5
    rec.persona_levels_self = self.levels;
  }

  // 1つ目の結果に答えたあと、2つ目の結果へ移る前の画面
  function viewNext() {
    progress(null);
    h(`
      <div class="done">
        <div class="check-circle">2</div>
        <h1>ありがとうございます<br>もう1つだけお願いします</h1>
      </div>
      <div class="card">
        <p style="margin-top:0">次に、<b>同じ回答</b>をもとに、<b>別の書き方</b>で作った結果の説明を表示します。</p>
        <p class="sub" style="margin-bottom:0">おすすめの職種や相性%は1つ目と同じです。説明の文章を読んで、もう一度感想を教えてください。</p>
      </div>
      <div class="grow"></div>
      <div class="actions"><button class="btn" id="go">2つ目の結果を見る</button></div>
    `);
    document.getElementById("go").onclick = () => viewResult();
  }

  // ---------- 5. 結果 ----------
  function viewResult(readOnly) {
    progress(null);
    if (!readOnly) resultShownAt = Date.now();
    const top = result.ranked.slice(0, 3);
    const intro = j => (window.JOB_INTRO || {})[j.id] || { short: "", about: j.desc, example: "" };
    // 職種の「どんな仕事？」「たとえば…」ブロック（はじめて見る人向け）
    const jobInfo = (j, cls) => {
      const t = intro(j);
      return `<div class="jobinfo ${cls || ""}">
        <div class="ji-row"><span class="ji-label">どんな仕事？</span><span>${t.about}</span></div>
        ${t.example ? `<div class="ji-row"><span class="ji-label">たとえば…</span><span>${t.example}</span></div>` : ""}
        ${personHtml(t)}
      </div>`;
    };
    h(`
      ${ORDER.length > 1 && !readOnly ? `<div class="stage-badge">結果の説明 ${stage + 1} / ${ORDER.length}</div>` : ""}
      <div class="result-hero">
        <div class="label">あなたに最も合う職種</div>
        <div class="hero-icon">${top[0].job.icon}</div>
        <div class="job">${top[0].job.name}</div>
        <div class="match">相性 ${top[0].match}%</div>
        ${intro(top[0].job).short ? `<div class="short">${intro(top[0].job).short}</div>` : ""}
        ${jobInfo(top[0].job, "on-hero")}
      </div>
      ${(() => {
        const p = personality(textAxis(top));
        return `<h2>あなたの性格</h2>
        <div class="card persona">
          <div class="persona-type">あなたは<br><b>「${p.type}」</b>タイプ</div>
          ${p.keys.length ? `<div class="persona-keys">${p.keys.map(k => `<span>#${k}</span>`).join("")}</div>` : ""}
          <p class="persona-text">${p.summary(top[0].job.name)}</p>
        </div>`;
      })()}
      <h2>2位・3位の職種</h2>
      ${top.slice(1).map((r, k) => `
        <div class="card">
          <div class="rank">
            <div class="ic">${r.job.icon}</div>
            <div style="flex:1">
              <div class="no">${k + 2}位</div>
              <div class="name">${r.job.name} <span class="pct">${r.match}%</span></div>
              <div class="meter"><i style="width:${r.match}%"></i></div>
              ${intro(r.job).short ? `<div class="short-sub">${intro(r.job).short}</div>` : ""}
            </div>
          </div>
          ${jobInfo(r.job)}
        </div>`).join("")}
      <h2>あなたの5つの傾向</h2>
      <div class="card">
        ${(() => {
          const p = personality(textAxis(top));
          return AXES.map(a => {
            const s = result.axis[a.key], pct = ((s + 2) / 4) * 100, line = p.axisLine(a);
            return `<div class="axis">
              ${a.about ? `<div class="axis-about">${a.about}</div>` : ""}
              <div class="ends"><span class="${s < 0 ? "on" : ""}">${a.left}</span><span class="${s > 0 ? "on" : ""}">${a.right}</span></div>
              <div class="track"><div class="pin" style="left:${pct}%"></div></div>
              <div class="axis-you"><span class="axis-label ${line.side}">${line.label}</span><span>${line.text}</span></div>
            </div>`;
          }).join("");
        })()}
      </div>
      ${readOnly ? `<div class="actions"><button class="btn" id="close">閉じる</button></div>` : feedbackHtml(top)}
    `);
    if (readOnly) { document.getElementById("close").onclick = viewDone; return; }
    bindFeedback();
  }

  // ---------- 6. 納得度・しっくり職種・自由記述（結果の下に続けて表示） ----------
  // 説明文の元にするスコア：変動式＝本人の軸スコア／固定式＝1位の職種の理想スコア
  function textAxis(top) {
    if (!isFixed()) return result.axis;
    return Object.fromEntries(AXES.map((a, i) => [a.key, top[0].job.p[i]]));
  }

  // ---------- 性格の説明文（軸スコアから組み立てる。AIは使わない） ----------
  function personality(axis) {
    const P = window.PERSONALITY;
    const lv = s => s <= -1 ? "L2" : s <= -0.34 ? "L1" : s < 0.34 ? "N" : s < 1 ? "R1" : "R2";
    // 偏りが強い軸から順に並べる
    const order = AXES.map(a => ({ key: a.key, s: axis[a.key] })).sort((x, y) => Math.abs(y.s) - Math.abs(x.s));
    const top = order[0];
    const typeCode = lv(top.s) === "N" ? "BAL" : top.key + (top.s < 0 ? "L" : "R");
    const type = typeCode === "BAL" ? P.BALANCED_TYPE : P[top.key][top.s < 0 ? "L" : "R"].type;
    const keys = order.filter(o => lv(o.s) !== "N").map(o => P[o.key][o.s < 0 ? "L" : "R"].key);
    const levels = AXES.map(a => a.key + ":" + lv(axis[a.key])).join(" ");
    // まとめ文：偏りの強い上位2つの「強み」と、1位の職種をつなげる
    const strong = order.filter(o => lv(o.s) !== "N").slice(0, 2).map(o => P[o.key][o.s < 0 ? "L" : "R"].strength);
    const summary = (jobName) => !strong.length
      ? `どの傾向にも大きな偏りがなく、場面に合わせて柔軟に動けるタイプです。いろいろな職種で力を発揮できる可能性があります。`
      : `あなたのいちばんの強みは、${strong[0]}です。` + (strong[1] ? `さらに、${strong[1]}も持っています。` : "") +
        `この強みは「${jobName}」の仕事で特に活かせそうです。`;
    // 軸ごとの「あなたはどういう人か」
    const axisLine = a => {
      const s = axis[a.key], l = lv(s);
      const label = l === "N" ? "バランス型" : `${l.endsWith("2") ? "とても" : "やや"}${s < 0 ? a.left : a.right}寄り`;
      return { label, text: P[a.key][l], side: l === "N" ? "" : s < 0 ? "l" : "r" };
    };
    return { typeCode, type, keys, levels, summary, axisLine };
  }

  // 「こんな人に向いている」のブロック
  function personHtml(t) {
    if (!t.person || !t.person.length) return "";
    return `<div class="ji-row"><span class="ji-label">こんな人に向いている</span>
      <ul class="person">${t.person.map(p => `<li>${p}</li>`).join("")}</ul></div>`;
  }

  // 「一番しっくりくる職種」の選択肢。タップして選ぶと、その職種の説明が開く
  function fitLabel(r, k) {
    const t = (window.JOB_INTRO || {})[r.job.id] || { about: r.job.desc };
    return `<span class="fit-body">
      <span>${r.job.icon} ${k + 1}位：${r.job.name}</span>
      ${t.short ? `<span class="sub">${t.short}</span>` : ""}
      <span class="opt-detail">
        <span class="ji-label">どんな仕事？</span><span>${t.about}</span>
        ${t.example ? `<span class="ji-label" style="margin-top:6px">たとえば…</span><span>${t.example}</span>` : ""}
        ${t.person ? `<span class="ji-label" style="margin-top:6px">こんな人に向いている</span>${t.person.map(p => `<span>✓ ${p}</span>`).join("")}` : ""}
      </span>
    </span>`;
  }

  function feedbackHtml(top) {
    const lik = (key, q) => `
      <div class="field"><div class="q">${q}</div>
        <div class="likert">${[1, 2, 3, 4, 5].map(v => `<button data-k="${key}" data-v="${v}">${v}</button>`).join("")}</div>
        <div class="likert-labels"><span>まったくそう思わない</span><span>とてもそう思う</span></div>
      </div>`;
    return `
      <div class="divider"><span>▼ 診断結果についてお聞きします</span></div>
      <p class="sub" style="text-align:center;margin-top:0">結果を見ながら答えてください。あと少しで終わりです。</p>
      ${lik("sat_overall", "この診断結果に納得できますか？")}
      <h2>くわしく教えてください</h2>
      ${lik("sat_accurate", "自分の性格を言い当てている")}
      ${lik("sat_insight", "新しい気づきがあった")}
      ${lik("sat_useful", "職種選びの参考になる")}
      <div class="field"><div class="q">一番しっくりくる職種はどれですか？</div>
        <p class="sub" style="margin-top:0">1〜3位にないときは「その他の職種」から選んでください。</p>
        <div class="opts">
          ${top.map((r, k) => `<button class="opt" data-fit="${r.job.id}" data-rank="${k + 1}" data-match="${r.match}">${fitLabel(r, k)}</button>`).join("")}
          <button class="opt" id="fitOtherBtn" data-fitother="1">その他の職種（4位以下から選ぶ）</button>
          <div class="opts fit-other" id="fitOther" hidden>
            ${result.ranked.slice(3).map((r, k) => `<button class="opt" data-fit="${r.job.id}" data-rank="${k + 4}" data-match="${r.match}">${fitLabel(r, k + 3)}</button>`).join("")}
          </div>
          <button class="opt" data-fit="none" data-rank="0" data-match="">どれもしっくりこない</button>
        </div>
      </div>
      <div class="field"><div class="q">納得度について、なぜそう思いましたか？</div>
        <textarea id="free" placeholder="例：人と話すのが好きなのでコンサルは当たっていると思った"></textarea>
      </div>
      ${needPref() ? `
      <div class="field"><div class="q">1つ目と2つ目、どちらの結果の説明のほうがしっくりきましたか？</div>
        <div class="opts">
          <button class="opt" data-pref="1">1つ目の説明</button>
          <button class="opt" data-pref="2">2つ目の説明（いま表示している説明）</button>
          <button class="opt" data-pref="0">同じくらい</button>
        </div>
      </div>` : ""}
      <div class="actions"><button class="btn" id="go" disabled>${isLastStage() ? "送信する" : "次へ"}</button></div>
    `;
  }
  const isLastStage = () => stage === ORDER.length - 1;
  const needPref = () => ORDER.length > 1 && isLastStage();

  function bindFeedback() {
    const go = document.getElementById("go"), v = {};
    const label = isLastStage() ? "送信する" : "次へ";
    // 1つ目の結果は sat_overall など、2つ目の結果は sat2_overall などに記録する
    const col = k => stage === 0 ? k : k.replace(/^(sat|fit|free_text|result)/, "$12");
    // 最初に質問へ答えた時点までを「結果を見ていた時間」として記録し、離脱位置を feedback に進める
    const touched = () => {
      if (rec[col("result_view_sec")] !== "") return;
      rec[col("result_view_sec")] = +((Date.now() - resultShownAt) / 1000).toFixed(1);
      step(stage === 0 ? "feedback" : "feedback2");
    };
    const required = ["sat_overall", "sat_accurate", "sat_insight", "sat_useful", "fit_job"].concat(needPref() ? ["pref"] : []);
    const validate = () => {
      const left = required.filter(k => v[k] === undefined).length;
      go.disabled = left > 0;
      go.textContent = left ? `${label}（あと${left}問）` : label;
    };
    $app.querySelectorAll("[data-pref]").forEach(b => b.onclick = () => {
      touched();
      $app.querySelectorAll("[data-pref]").forEach(x => x.classList.remove("on"));
      b.classList.add("on"); v.pref = b.dataset.pref; validate();
    });
    validate();
    $app.querySelectorAll(".likert button").forEach(b => b.onclick = () => {
      touched();
      $app.querySelectorAll(`.likert button[data-k="${b.dataset.k}"]`).forEach(x => x.classList.remove("on"));
      b.classList.add("on"); v[b.dataset.k] = Number(b.dataset.v); validate();
    });
    const otherBtn = document.getElementById("fitOtherBtn"), otherBox = document.getElementById("fitOther");
    $app.querySelectorAll("[data-fit]").forEach(b => b.onclick = () => {
      touched();
      $app.querySelectorAll("[data-fit]").forEach(x => x.classList.remove("on"));
      b.classList.add("on");
      // 「その他の職種」の中から選んだときは「その他」も選択中の見た目にする。それ以外を選んだら一覧を閉じる
      const inOther = otherBox && otherBox.contains(b);
      if (otherBtn) otherBtn.classList.toggle("on", inOther);
      if (otherBox && !inOther) otherBox.hidden = true;
      v.fit_job = b.dataset.fit; v.fit_rank = Number(b.dataset.rank); v.fit_match = b.dataset.match === "" ? "" : Number(b.dataset.match);
      validate();
    });
    // 「その他の職種」：4位以下の5職種を開く（職種を選ぶまでは未回答のまま）
    if (otherBtn) otherBtn.onclick = () => {
      touched();
      $app.querySelectorAll("[data-fit]").forEach(x => x.classList.remove("on"));
      otherBtn.classList.add("on");
      otherBox.hidden = false;
      delete v.fit_job; delete v.fit_rank; delete v.fit_match;
      validate();
    };
    go.onclick = () => {
      Object.entries(v).forEach(([k, val]) => { if (k !== "pref") rec[col(k)] = val; });
      rec[col("free_text")] = document.getElementById("free").value.trim();
      rec[col("free_text_len")] = rec[col("free_text")].length;
      if (needPref()) { rec.pref = v.pref; rec.pref_type = v.pref === "0" ? "same" : ORDER[Number(v.pref) - 1]; }
      if (!isLastStage()) {
        // 2つ目の結果へ（同じ回答・同じ職種のまま、説明文の方式だけ切り替える）
        stage++;
        recordPersona();
        step("result2");
        viewNext();
        return;
      }
      rec.completed = 1; rec.completed_at = now(); rec.total_sec = +((Date.now() - t0) / 1000).toFixed(1);
      step("done", "completed");
      viewDone();
    };
  }

  function viewDone() {
    h(`
      <div class="done">
        <div class="check-circle">✓</div>
        <h1>ご協力ありがとう<br>ございました</h1>
      </div>
      <div class="card"><p class="sub" style="margin:0;text-align:center">${rec.round === 1 ? "4年生の夏に2回目をお願いします。そのときも同じ「小学校・兄弟姉妹の数・誕生月」で答えてください。" : "2回目のご回答ありがとうございました。"}</p></div>
      <div class="grow"></div>
      <div class="actions">
        <button class="btn ghost" id="again">結果をもう一度見る</button>
        <button class="btn" id="finish">終わる</button>
      </div>
    `);
    document.getElementById("again").onclick = () => { viewResult(true); };
    document.getElementById("finish").onclick = viewFinish;
  }

  // 「終わる」：回答は送信済み。タブを閉じてみて、閉じられないブラウザ（スマホの多く）では案内を出す
  function viewFinish() {
    try { window.close(); } catch (e) {}
    setTimeout(() => {
      progress(null);
      h(`
        <div class="done">
          <div class="check-circle">✓</div>
          <h1>終了しました</h1>
          <p class="sub">回答はすべて送信済みです。<br>このタブ（画面）を閉じて終了してください。</p>
        </div>
      `);
    }, 300);
  }

  viewConsent();
})();
