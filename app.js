(function () {
  "use strict";
  const CFG = window.APP_CONFIG, AXES = window.AXES, JOBS = window.JOBS;
  const $app = document.getElementById("app");
  const TEST_MODE = !CFG.ENDPOINT;
  if (TEST_MODE) document.getElementById("testBadge").hidden = false;

  // ---------- 設問数：1回目=15問、2回目=10問（回数の選択時に決まる） ----------
  // 表示順は A1,B1,C1,D1,E1,A2,... と軸を交互にする（10問版は15問版の先頭10問と同じ）
  // グループ：配布URLの ?g=A / ?g=B で決める（指定なしは DEFAULT_GROUP）
  //   A：1回目15問 → 2回目10問 ／ B：1回目10問 → 2回目15問（順番の入れ替え＝カウンターバランス）
  const gParam = (new URLSearchParams(location.search).get("g") || "").toUpperCase();
  const GROUP = CFG.VERSION_BY_GROUP[gParam] ? gParam : CFG.DEFAULT_GROUP;
  let QS = [];
  function setRound(round) {
    rec.round = round;
    rec.version = CFG.VERSION_BY_GROUP[GROUP][round];
    const perAxis = rec.version === 10 ? 2 : 3;
    QS = [];
    for (let n = 1; n <= perAxis; n++) AXES.forEach(a => QS.push(window.QUESTIONS.find(q => q.id === a.key + n)));
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
    respondent_id: "", group: GROUP, round: "", version: "",
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
    result_view_sec: "",
    sat_overall: "", sat_accurate: "", sat_insight: "", sat_useful: "",
    fit_job: "", fit_rank: "", fit_match: "", free_text: "", free_text_len: "",
  });
  // 15問版のときだけ値が入る（10問版の行は空欄）
  AXES.forEach(a => { rec["sim10_score_" + a.key] = ""; });
  Object.assign(rec, {
    sim10_top1_job: "", sim10_top1_match: "", sim10_top2_job: "", sim10_top2_match: "", sim10_top3_job: "", sim10_top3_match: "",
    sim10_same_top1: "", sim10_top3_overlap: "", sim10_max_streak: "", sim10_questions_sec: "",
  });
  const t0 = Date.now();

  function send(useBeacon) {
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
        <p>かんたんな質問に答えるだけで、8つの職種から相性のよい職種を診断します。</p>
        <div class="chips"><span class="chip">⏱ 約3〜5分</span><span class="chip">🔒 匿名</span><span class="chip">💼 8職種</span></div>
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
      step("attributes"); viewAttributes();
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
      <div class="actions"><button class="btn" id="go" disabled>診断をはじめる（${QS.length}問）</button></div>
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
    progress(i / QS.length);
    const q = QS[i];
    rec.last_step = "q" + (i + 1);
    shownAt = Date.now();
    h(`
      <div class="qhead"><span class="n">Q${i + 1}</span><span class="of">/ ${QS.length}</span></div>
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
      if (answers[q.id] && answers[q.id] !== v) rec.n_changes++;
      answers[q.id] = v;
      $app.querySelectorAll(".dot").forEach(x => x.classList.toggle("on", x === b));
      $app.querySelectorAll(".dot").forEach(x => { x.disabled = true; });
      leave();
      rec["q_" + q.id] = v; rec["t_" + q.id] = +(timeMs[q.id] / 1000).toFixed(2);
      setTimeout(() => {
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
    const maxD = Math.sqrt(AXES.length * 16);
    const ranked = JOBS.map(j => {
      const d = Math.sqrt(j.p.reduce((acc, p, k) => acc + (u[k] - p) ** 2, 0));
      return { job: j, match: Math.round(100 * (1 - d / maxD)) };
    }).sort((a, b) => b.match - a.match);
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

    // 15問版のみ：同じ回答を先頭10問（各軸1・2問目）だけで採点し直した結果を記録する。
    // 同じ人・同じ時点のデータで「設問を減らすと結果がどれだけ変わるか」を比べられる。
    if (QS.length === 15) {
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

  // ---------- 5. 結果 ----------
  function viewResult(readOnly) {
    progress(null);
    if (!readOnly) resultShownAt = Date.now();
    const top = result.ranked.slice(0, 3);
    h(`
      <div class="result-hero">
        <div class="label">あなたに最も合う職種</div>
        <div class="hero-icon">${top[0].job.icon}</div>
        <div class="job">${top[0].job.name}</div>
        <div class="match">相性 ${top[0].match}%</div>
        <div class="desc">${top[0].job.desc}</div>
      </div>
      <h2>2位・3位の職種</h2>
      ${top.slice(1).map((r, k) => `
        <div class="card rank">
          <div class="ic">${r.job.icon}</div>
          <div style="flex:1">
            <div class="no">${k + 2}位</div>
            <div class="name">${r.job.name} <span class="pct">${r.match}%</span></div>
            <div class="meter"><i style="width:${r.match}%"></i></div>
            <div class="sub" style="margin-top:6px">${r.job.desc}</div>
          </div>
        </div>`).join("")}
      <h2>あなたの5つの傾向</h2>
      <div class="card">
        ${AXES.map(a => {
          const s = result.axis[a.key], pct = ((s + 2) / 4) * 100;
          return `<div class="axis"><div class="ends"><span class="${s < 0 ? "on" : ""}">${a.left}</span><span class="${s > 0 ? "on" : ""}">${a.right}</span></div>
            <div class="track"><div class="pin" style="left:${pct}%"></div></div></div>`;
        }).join("")}
      </div>
      ${readOnly ? `<div class="actions"><button class="btn" id="close">閉じる</button></div>` : feedbackHtml(top)}
    `);
    if (readOnly) { document.getElementById("close").onclick = viewDone; return; }
    bindFeedback();
  }

  // ---------- 6. 納得度・しっくり職種・自由記述（結果の下に続けて表示） ----------
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
      <div class="field"><div class="q">1〜3位のうち、一番しっくりくる職種はどれですか？</div>
        <div class="opts">
          ${top.map((r, k) => `<button class="opt" data-fit="${r.job.id}" data-rank="${k + 1}" data-match="${r.match}">${r.job.icon} ${k + 1}位：${r.job.name}</button>`).join("")}
          <button class="opt" data-fit="none" data-rank="0" data-match="">どれもしっくりこない</button>
        </div>
      </div>
      <div class="field"><div class="q">納得度について、なぜそう思いましたか？</div>
        <textarea id="free" placeholder="例：人と話すのが好きなのでコンサルは当たっていると思った"></textarea>
      </div>
      <div class="actions"><button class="btn" id="go" disabled>送信する</button></div>
    `;
  }

  function bindFeedback() {
    const go = document.getElementById("go"), v = {};
    // 最初に質問へ答えた時点までを「結果を見ていた時間」として記録し、離脱位置を feedback に進める
    const touched = () => {
      if (rec.result_view_sec !== "") return;
      rec.result_view_sec = +((Date.now() - resultShownAt) / 1000).toFixed(1);
      step("feedback");
    };
    const validate = () => {
      go.disabled = !(v.sat_overall && v.sat_accurate && v.sat_insight && v.sat_useful && v.fit_job);
      go.textContent = go.disabled ? `送信する（あと${["sat_overall", "sat_accurate", "sat_insight", "sat_useful", "fit_job"].filter(k => !v[k]).length}問）` : "送信する";
    };
    validate();
    $app.querySelectorAll(".likert button").forEach(b => b.onclick = () => {
      touched();
      $app.querySelectorAll(`.likert button[data-k="${b.dataset.k}"]`).forEach(x => x.classList.remove("on"));
      b.classList.add("on"); v[b.dataset.k] = Number(b.dataset.v); validate();
    });
    $app.querySelectorAll("[data-fit]").forEach(b => b.onclick = () => {
      touched();
      $app.querySelectorAll("[data-fit]").forEach(x => x.classList.remove("on"));
      b.classList.add("on");
      v.fit_job = b.dataset.fit; v.fit_rank = Number(b.dataset.rank); v.fit_match = b.dataset.match === "" ? "" : Number(b.dataset.match);
      validate();
    });
    go.onclick = () => {
      Object.assign(rec, v);
      rec.free_text = document.getElementById("free").value.trim();
      rec.free_text_len = rec.free_text.length;
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
      <div class="actions"><button class="btn ghost" id="again">結果をもう一度見る</button></div>
    `);
    document.getElementById("again").onclick = () => { viewResult(true); };
  }

  viewConsent();
})();
