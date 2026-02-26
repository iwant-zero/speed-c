import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const DATA_DIR = path.join(ROOT, "data");
const DRAWS_FILE = path.join(DATA_DIR, "speed_draws.json");
const FREQ_FILE = path.join(DATA_DIR, "speed_freq.json");

// ✅ Pages 소스가 speed-c/로 잡혀도 404 안 나게: speed-c/data로도 미러링
const PUBLIC_DATA_DIR = path.join(ROOT, "speed-c", "data");
const PUBLIC_DRAWS_FILE = path.join(PUBLIC_DATA_DIR, "speed_draws.json");
const PUBLIC_FREQ_FILE = path.join(PUBLIC_DATA_DIR, "speed_freq.json");

// 스피드키노: 1~70 숫자
const MIN_NUM = 1;
const MAX_NUM = 70;

// 최근 빈도 창(대략 1일치 근사)
const RECENT_WINDOW = 288;

// 공개 API
const API_URL = "https://api.bepick.io/keno/get/";

function nowIso() {
  return new Date().toISOString();
}

async function readJson(filePath, fallback) {
  try {
    const txt = await fs.readFile(filePath, "utf8");
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, data) {
  const txt = JSON.stringify(data, null, 2) + "\n";
  await fs.writeFile(filePath, txt, "utf8");
}

function parseNumberList(s) {
  if (!s || typeof s !== "string") return [];
  const nums = s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));

  const uniq = Array.from(new Set(nums));
  uniq.sort((a, b) => a - b);
  return uniq;
}

function keyOfDraw(d) {
  if (d.dhRound != null) return `dh:${d.dhRound}`;
  return `id:${d.id ?? `${d.date ?? "0"}-${d.round ?? "0"}`}`;
}

async function fetchLatest30() {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 15_000);

  const res = await fetch(API_URL, {
    signal: ac.signal,
    headers: {
      "user-agent": "speed-c-bot/1.0 (github actions)",
      accept: "application/json",
    },
  }).finally(() => clearTimeout(t));

  if (!res.ok) throw new Error(`API HTTP ${res.status} ${res.statusText}`);

  const json = await res.json();
  if (Array.isArray(json)) return json;
  if (Array.isArray(json?.data)) return json.data;
  throw new Error("Unexpected API response shape");
}

function normalizeRecords(rawArr) {
  const dh = rawArr.filter((x) => (x?.gameType || "") === "dhlottery.co.kr");
  const arr = dh.length ? dh : rawArr;

  const out = [];
  for (const x of arr) {
    const sk = x?.SpeedKeno || {};
    const numbers = parseNumberList(sk?.Number);

    const filtered = numbers.filter((n) => n >= MIN_NUM && n <= MAX_NUM);

    out.push({
      id: x?.ID ?? null,
      date: x?.Date ?? null,
      round: x?.Round ?? null,
      gameType: x?.gameType ?? null,
      dhRound: x?.dhRound ?? null,
      numbers: filtered,
      lucky: sk?.Lucky ?? null,
      sum: sk?.Sum ?? null,
      fetchedAt: nowIso(),
    });
  }
  return out;
}

function sortDrawsDesc(draws) {
  return [...draws].sort((a, b) => {
    const ad = a.dhRound ?? -1;
    const bd = b.dhRound ?? -1;
    if (ad !== -1 || bd !== -1) return bd - ad;

    const adate = Number(a.date ?? 0);
    const bdate = Number(b.date ?? 0);
    if (adate !== bdate) return bdate - adate;

    return Number(b.round ?? 0) - Number(a.round ?? 0);
  });
}

function buildFreq(draws) {
  const freq = {};
  for (let n = MIN_NUM; n <= MAX_NUM; n++) freq[String(n)] = 0;

  let totalBalls = 0;
  for (const d of draws) {
    for (const n of d.numbers || []) {
      const k = String(n);
      if (k in freq) {
        freq[k] += 1;
        totalBalls += 1;
      }
    }
  }

  const rank = Object.entries(freq)
    .map(([k, v]) => ({ n: Number(k), count: v }))
    .sort((a, b) => (b.count - a.count) || (a.n - b.n));

  return { freq, rank, totalBalls };
}

function buildScoreRank(freqObj, recentObj, wAll = 0.7, wRecent = 1.3) {
  const score = [];
  for (let n = MIN_NUM; n <= MAX_NUM; n++) {
    const k = String(n);
    const all = freqObj[k] ?? 0;
    const rec = recentObj[k] ?? 0;
    const s = all * wAll + rec * wRecent;
    score.push({ n, score: s, all, rec });
  }
  score.sort((a, b) => (b.score - a.score) || (b.rec - a.rec) || (b.all - a.all) || (a.n - b.n));
  return score;
}

function makePickSet({ baseRankNums, plan, caps, offset, step, maxTries = 200 }) {
  const underLine = 35;

  const top = baseRankNums.slice(0, plan.topCut);
  const mid = baseRankNums.slice(plan.topCut, plan.midCut);
  const low = baseRankNums.slice(plan.midCut);

  function attempt(c) {
    const picked = [];
    const used = new Set();
    const lastDigit = new Set();

    let odd = 0, even = 0, under = 0, over = 0;

    const isOdd = (n) => (n % 2) === 1;
    const isUnder = (n) => n <= underLine;

    const okGap = (n) => {
      if (!c.minGap) return true;
      for (const p of picked) {
        if (Math.abs(p - n) < c.minGap) return false;
      }
      return true;
    };

    const canAdd = (n) => {
      if (used.has(n)) return false;
      if (!okGap(n)) return false;

      const oddish = isOdd(n);
      const underish = isUnder(n);

      if (c.maxOdd != null && oddish && odd >= c.maxOdd) return false;
      if (c.maxEven != null && !oddish && even >= c.maxEven) return false;

      if (c.maxUnder != null && underish && under >= c.maxUnder) return false;
      if (c.maxOver != null && !underish && over >= c.maxOver) return false;

      if (c.uniqueLastDigit) {
        const d = n % 10;
        if (lastDigit.has(d)) return false;
      }
      return true;
    };

    const add = (n) => {
      used.add(n);
      picked.push(n);

      if (isOdd(n)) odd += 1;
      else even += 1;

      if (isUnder(n)) under += 1;
      else over += 1;

      if (c.uniqueLastDigit) lastDigit.add(n % 10);
    };

    function pickFrom(arr, need, seedOff) {
      if (need <= 0) return;
      if (!arr.length) return;

      for (let i = 0; i < maxTries && picked.length < 10 && need > 0; i++) {
        const idx = (seedOff + i * step) % arr.length;
        const n = arr[idx];
        if (canAdd(n)) {
          add(n);
          need -= 1;
        }
      }
    }

    pickFrom(top, plan.topN, offset + 3);
    pickFrom(mid, plan.midN, offset + 17);
    pickFrom(low, plan.lowN, offset + 41);

    if (picked.length < 10) {
      for (let i = 0; i < baseRankNums.length && picked.length < 10; i++) {
        const idx = (offset + i * step) % baseRankNums.length;
        const n = baseRankNums[idx];
        if (canAdd(n)) add(n);
      }
    }

    if (picked.length < 10) {
      for (const n of baseRankNums) {
        if (picked.length >= 10) break;
        if (!used.has(n)) {
          used.add(n);
          picked.push(n);
        }
      }
    }

    picked.sort((a, b) => a - b);
    return picked.slice(0, 10);
  }

  const strict = { ...caps };
  const relax1 = { ...caps, uniqueLastDigit: false };
  const relax2 = { ...relax1, minGap: 0 };
  const relax3 = { ...relax2, maxUnder: null, maxOver: null };
  const relax4 = { ...relax3, maxOdd: null, maxEven: null };

  return attempt(strict) || attempt(relax1) || attempt(relax2) || attempt(relax3) || attempt(relax4);
}

function generateRecommendations(freqData, count) {
  const latestSeed = Number(freqData?.latest?.dhRound ?? 0) || 0;

  const overallNums = (freqData.rank || []).map((x) => x.n);
  const recentNums = (freqData.recentRank || []).map((x) => x.n);

  const scoreRank = buildScoreRank(freqData.freq, freqData.recentFreq);
  const scoreNums = scoreRank.map((x) => x.n);

  const recipes = [
    {
      label: "믹스(누적+최근) / 균형(홀짝 5:5, 언더/오버 5:5)",
      base: "score",
      plan: { topCut: 24, midCut: 52, topN: 6, midN: 3, lowN: 1 },
      caps: { maxOdd: 5, maxEven: 5, maxUnder: 5, maxOver: 5, minGap: 2, uniqueLastDigit: true },
    },
    {
      label: "최근 뜨는 쪽(최근 가중) / 분산",
      base: "recent",
      plan: { topCut: 24, midCut: 52, topN: 7, midN: 2, lowN: 1 },
      caps: { maxOdd: 6, maxEven: 4, maxUnder: 6, maxOver: 4, minGap: 2, uniqueLastDigit: true },
    },
    {
      label: "누적 상위(장기 빈도) / 균형",
      base: "overall",
      plan: { topCut: 20, midCut: 50, topN: 6, midN: 3, lowN: 1 },
      caps: { maxOdd: 5, maxEven: 5, maxUnder: 5, maxOver: 5, minGap: 1, uniqueLastDigit: false },
    },
    {
      label: "언더(1~35) 쏠림 / 상·중·하 혼합",
      base: "score",
      plan: { topCut: 24, midCut: 52, topN: 5, midN: 4, lowN: 1 },
      caps: { maxOdd: 6, maxEven: 4, maxUnder: 7, maxOver: 3, minGap: 2, uniqueLastDigit: false },
    },
    {
      label: "오버(36~70) 쏠림 / 상·중·하 혼합",
      base: "score",
      plan: { topCut: 24, midCut: 52, topN: 5, midN: 4, lowN: 1 },
      caps: { maxOdd: 4, maxEven: 6, maxUnder: 3, maxOver: 7, minGap: 2, uniqueLastDigit: false },
    },
    {
      label: "끝수 분산(0~9 중복 최소) / 균형",
      base: "score",
      plan: { topCut: 28, midCut: 56, topN: 6, midN: 3, lowN: 1 },
      caps: { maxOdd: 5, maxEven: 5, maxUnder: 5, maxOver: 5, minGap: 1, uniqueLastDigit: true },
    },
    {
      label: "간격 넓게(뭉침 최소) / 분산",
      base: "score",
      plan: { topCut: 24, midCut: 52, topN: 6, midN: 3, lowN: 1 },
      caps: { maxOdd: 5, maxEven: 5, maxUnder: 5, maxOver: 5, minGap: 3, uniqueLastDigit: false },
    },
    {
      label: "하위 스파이스(저빈도 비중↑) / 변주",
      base: "overall",
      plan: { topCut: 20, midCut: 50, topN: 4, midN: 3, lowN: 3 },
      caps: { maxOdd: 6, maxEven: 4, maxUnder: 5, maxOver: 5, minGap: 1, uniqueLastDigit: false },
    },
    {
      label: "홀수 우세(6:4) / 믹스",
      base: "score",
      plan: { topCut: 24, midCut: 52, topN: 6, midN: 3, lowN: 1 },
      caps: { maxOdd: 6, maxEven: 4, maxUnder: 5, maxOver: 5, minGap: 1, uniqueLastDigit: false },
    },
    {
      label: "짝수 우세(4:6) / 믹스",
      base: "score",
      plan: { topCut: 24, midCut: 52, topN: 6, midN: 3, lowN: 1 },
      caps: { maxOdd: 4, maxEven: 6, maxUnder: 5, maxOver: 5, minGap: 1, uniqueLastDigit: false },
    },
  ];

  const baseBy = (which) => {
    if (which === "recent" && recentNums.length) return recentNums;
    if (which === "overall" && overallNums.length) return overallNums;
    return scoreNums.length ? scoreNums : (overallNums.length ? overallNums : recentNums);
  };

  const step = 11;
  const sets = [];

  for (let i = 0; i < count; i++) {
    const r = recipes[i % recipes.length];
    const baseRankNums = baseBy(r.base);
    const offset = (latestSeed + i * 17 + 31) % Math.max(1, baseRankNums.length);

    const nums = makePickSet({
      baseRankNums,
      plan: r.plan,
      caps: r.caps,
      offset,
      step,
    });

    sets.push({ label: r.label, nums });
  }

  return sets;
}

function formatSetLine(nums) {
  return nums.map((n) => String(n).padStart(2, "0")).join("  ");
}

function statsOf(nums) {
  const underLine = 35;
  let odd = 0, under = 0, sum = 0;
  for (const n of nums) {
    if (n % 2 === 1) odd += 1;
    if (n <= underLine) under += 1;
    sum += n;
  }
  return { odd, even: nums.length - odd, under, over: nums.length - under, sum };
}

async function cmdUpdate() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(PUBLIC_DATA_DIR, { recursive: true }); // ✅ 추가

  const existing = await readJson(DRAWS_FILE, []);
  const existingArr = Array.isArray(existing) ? existing : [];

  const raw = await fetchLatest30();
  const normalized = normalizeRecords(raw);

  const map = new Map();
  for (const d of existingArr) map.set(keyOfDraw(d), d);
  for (const d of normalized) map.set(keyOfDraw(d), d);

  const merged = sortDrawsDesc(Array.from(map.values()));

  const { freq, rank, totalBalls } = buildFreq(merged);

  const recentSlice = merged.slice(0, Math.min(RECENT_WINDOW, merged.length));
  const recentBuilt = buildFreq(recentSlice);

  const latest = merged[0] || null;
  const numbersPerDraw =
    (latest?.numbers && Array.isArray(latest.numbers) && latest.numbers.length) ? latest.numbers.length : null;

  const freqDoc = {
    updatedAt: nowIso(),
    source: { api: API_URL, note: "gameType이 dhlottery.co.kr 인 레코드를 우선 사용 (없으면 전체 사용)" },
    range: { min: MIN_NUM, max: MAX_NUM },
    numbersPerDraw,
    totalDraws: merged.length,
    totalBalls,
    latest: latest ? { dhRound: latest.dhRound ?? null, date: latest.date ?? null, round: latest.round ?? null } : null,
    freq,
    rank,
    recentWindow: RECENT_WINDOW,
    recentFreq: recentBuilt.freq,
    recentRank: recentBuilt.rank,
  };

  // ✅ 루트(data) 저장
  await writeJson(DRAWS_FILE, merged);
  await writeJson(FREQ_FILE, freqDoc);

  // ✅ speed-c/data에도 동일 파일 저장 (Pages 소스가 speed-c여도 OK)
  await writeJson(PUBLIC_DRAWS_FILE, merged);
  await writeJson(PUBLIC_FREQ_FILE, freqDoc);

  console.log(`[OK] Updated draws=${merged.length}, updatedAt=${freqDoc.updatedAt}`);
}

async function cmdRecommend(count) {
  const freqDoc = await readJson(FREQ_FILE, null);
  if (!freqDoc || !freqDoc.freq) {
    console.log("데이터가 아직 없습니다. 먼저 update 워크플로우(또는 update 명령)를 실행해 주세요.");
    process.exit(0);
  }

  const n = Math.max(1, Math.min(10, Number(count) || 10));
  const sets = generateRecommendations(freqDoc, n);

  const latest = freqDoc.latest?.dhRound ?? "-";
  const updatedAt = freqDoc.updatedAt ?? "-";
  const totalDraws = freqDoc.totalDraws ?? 0;

  console.log(`# 스피드키노 빈도 기반 추천 (${n}세트)`);
  console.log(`- 데이터 기준: 최신 회차(dhRound) **${latest}**, 누적 **${totalDraws}회**`);
  console.log(`- 데이터 갱신: **${updatedAt}**\n`);

  sets.forEach((s, idx) => {
    const st = statsOf(s.nums);
    console.log(`## ${idx + 1}) ${s.label}`);
    console.log(`- 번호(10개): ${formatSetLine(s.nums)}`);
    console.log(`- 통계: 홀/짝 ${st.odd}/${st.even} · 언더/오버 ${st.under}/${st.over} · 합 ${st.sum}\n`);
  });

  console.log(`---\n※ 참고: 과거 빈도는 미래 당첨을 보장하지 않습니다.`);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args[0] || "update";

  if (cmd === "recommend") {
    const i = args.indexOf("--count");
    const count = i >= 0 ? args[i + 1] : "10";
    return { cmd, count };
  }
  return { cmd };
}

const { cmd, count } = parseArgs(process.argv);

try {
  if (cmd === "update") await cmdUpdate();
  else if (cmd === "recommend") await cmdRecommend(count);
  else {
    console.log(`Unknown command: ${cmd}`);
    console.log(`Usage:
  node scripts/update_speed.mjs update
  node scripts/update_speed.mjs recommend --count 1|5|10`);
  }
} catch (e) {
  console.error("[ERROR]", e?.message || e);
  process.exit(1);
}
