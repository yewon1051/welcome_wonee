#!/usr/bin/env node
// public 저장소에 올리기 전 위험 패턴을 검사합니다. 의존성 없음.
// 사용: node scripts/check-public.mjs
// 예외 처리: 문제가 아닌 줄 끝에 `check-public:ignore` 주석을 붙이세요.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const SKIP_DIRS = new Set([".git", "node_modules", ".firebase"]);
const TEXT_EXT = new Set([".js", ".mjs", ".html", ".css", ".json", ".md", ".rules", ".yml", ".yaml", ".txt", ".webmanifest", ""]);
const SELF = "scripts/check-public.mjs";

// [이름, 정규식, 검사할 파일 필터(없으면 전체)]
const RULES = [
  ["공유방 초대 링크/코드", /[#&?]r=[a-z0-9]{12,}/i],
  ["주민등록번호 형태", /\b\d{6}-?[1-4]\d{6}\b/],
  ["휴대전화번호", /\b01[016789][- ]?\d{3,4}[- ]?\d{4}\b/],
  ["이메일 주소", /\b[\w.+-]+@(?!example\.|users\.noreply\.github\.com|anthropic\.com)[\w-]+\.[\w.-]+\b/i],
  ["카드번호 형태", /\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/],
  ["개인 키 / 서비스 계정", /-----BEGIN [A-Z ]*PRIVATE KEY-----|"type"\s*:\s*"service_account"|"private_key"\s*:/],
  ["출산(예정)일 기본값이 비어 있지 않음", /DEFAULT_BIRTH\s*=\s*["'][^"']+["']/, (f) => f.endsWith("seed.js")],
  ["Firestore 규칙이 열려 있음", /allow\s+[\w\s,]+:\s*if\s+true/, (f) => f.endsWith(".rules")],
  ["위험한 HTML 삽입 (XSS)", /\.innerHTML\s*[+]?=|insertAdjacentHTML|document\.write\(|\beval\(|new Function\(/, (f) => f.endsWith(".js") || f.endsWith(".html")],
  ["고정되지 않은 CDN 버전", /firebasejs\/(?!\d+\.\d+\.\d+['"`\/])/, (f) => f.endsWith(".js") || f.endsWith(".html")],
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const problems = [];
for (const file of walk(root)) {
  const rel = relative(root, file).split("\\").join("/");
  if (rel === SELF) continue;
  const base = basename(file);
  if (/^\.env/.test(base) || /\.(pem|key)$/.test(base) || /(service-?account|firebase-adminsdk)/i.test(base)) {
    problems.push(`${rel}: 비밀 값 파일은 저장소에 두면 안 돼요`);
    continue;
  }
  if (/\.(jpe?g|heic)$/i.test(base)) {
    problems.push(`${rel}: 사진/캡처 파일은 올리지 마세요 (개인·타인 정보 포함 가능)`);
    continue;
  }
  if (!TEXT_EXT.has(extname(file).toLowerCase())) continue;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes("check-public:ignore")) return;
    for (const [name, re, only] of RULES) {
      if (only && !only(rel)) continue;
      if (re.test(line)) problems.push(`${rel}:${i + 1}: ${name}`);
    }
  });
}

// config.js 점검: 웹 설정만 있어야 해요
try {
  const cfg = readFileSync(join(root, "config.js"), "utf8");
  if (/\bsecret\b|serviceAccount|client_secret/i.test(cfg)) problems.push("config.js: 비밀 값처럼 보이는 항목이 있어요");
} catch (e) { /* config.js 없으면 건너뜀 */ }

if (problems.length) {
  console.error("❌ 공개 저장소에 올리기 전에 확인이 필요해요:\n");
  for (const p of problems) console.error("  - " + p);
  console.error("\n문제가 아닌 줄이면 줄 끝에 `// check-public:ignore` 를 붙이세요.");
  process.exit(1);
}
console.log("✅ check-public 통과");
