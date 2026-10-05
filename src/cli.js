import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * lupa-search 실행 파일을 찾는다.
 *
 * 기기 전용 경로를 하드코딩하지 않는다 — 예전에 그렇게 했다가 옛 빌드·옛 DB를 봐서
 * "인덱스 없음"이나 낡은 결과가 나오는 사고가 있었다. 항상 이 순서로 탐색한다.
 */
export function findLupaSearch() {
  const candidates = [
    process.env.LUPA_SEARCH_PATH,
    "/Applications/Lupa.app/Contents/MacOS/lupa-search",
    join(homedir(), "Applications/Lupa.app/Contents/MacOS/lupa-search"),
    "/Applications/Lupa-dev.app/Contents/MacOS/lupa-search",
  ].filter(Boolean);

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  // 설정 → 일반 → "명령줄 도구 설치…" 로 심볼릭 링크를 만든 경우
  for (const path of ["/usr/local/bin/lupa-search", "/opt/homebrew/bin/lupa-search"]) {
    if (existsSync(path)) return path;
  }
  return null;
}

export class LupaNotInstalledError extends Error {
  constructor() {
    super(
      "Lupa를 찾을 수 없습니다. lupa-mcp는 Lupa 앱이 만든 검색 인덱스를 읽는 도구라 " +
        "앱이 설치돼 있어야 합니다.\n" +
        "  1. Mac App Store에서 Lupa 설치 (무료): https://lupa.kr\n" +
        "  2. 앱을 실행해 검색할 폴더를 등록하고 인덱싱이 끝나기를 기다립니다\n" +
        "  3. 설치 위치가 특이하다면 LUPA_SEARCH_PATH 환경변수로 직접 지정할 수 있습니다"
    );
    this.name = "LupaNotInstalledError";
  }
}

/** CLI 종료 코드 → 사람이 읽을 수 있는 설명 (CLI_GUIDE.md의 계약) */
const EXIT_MESSAGES = {
  1: "검색에 실패했습니다.",
  2:
    "검색 인덱스가 없습니다. Lupa 앱을 실행해 검색할 폴더를 등록하고 " +
    "인덱싱이 끝나기를 기다린 뒤 다시 시도하세요.",
  3: "그 파일의 본문이 인덱스에 없습니다. 이미지만 있는 문서이거나, 아직 내용 인덱싱 전이거나, 암호가 걸린 문서일 수 있습니다.",
  4:
    "배포용 한글 문서라 본문을 내주지 않습니다(작성자가 복사를 막아 둔 문서). " +
    "파일명과 위치만 안내하고, 내용은 사용자가 한글에서 직접 열어 확인하게 하세요.",
  64: "인자가 잘못됐습니다.",
};

/**
 * 설치된 Lupa가 `--content`(본문 읽기)를 지원하는가.
 *
 * 이 옵션은 앱 2.0부터 들어간다. 그 전 버전에 넘기면 "알 수 없는 플래그"로 종료 코드
 * 64가 나오는데, 그대로 노출하면 "인자가 잘못됐습니다"라는 엉뚱한 말이 된다.
 * 한 번만 확인하고 캐시한다.
 */
/**
 * lupa-search는 App Store 샌드박스로 서명돼 있다. 이미 샌드박스(`sandbox-exec`) 안에 있는
 * 프로세스가 띄우면 macOS가 기동 단계에서 SIGTRAP으로 죽인다(종료 코드 133).
 * Aside·Codex 같은 에이전트의 **셸 도구**가 그렇다. 에이전트의 MCP 서버 설정으로 띄우면
 * 샌드박스 밖이라 정상 동작한다(2026-09-17 Aside 1.0.914 확인).
 */
export class SandboxedLaunchError extends Error {
  constructor() {
    super(
      "lupa-search가 샌드박스 안에서 실행돼 macOS가 기동을 막았습니다(종료 코드 133). " +
        "에이전트의 셸 명령으로 띄우지 말고, 에이전트의 MCP 서버 설정에 Lupa를 등록하세요 " +
        "(Aside: 설정 ▸ Plugins & MCPs / Codex: codex mcp add lupa -- npx -y github:paeyoungpark-web/lupa-mcp). " +
        "Lupa 2.0.1부터는 앱의 설정 ▸ 일반 ▸ 'Aside에 연결…'로도 등록할 수 있습니다."
    );
    this.name = "SandboxedLaunchError";
  }
}

function isSandboxKill(error) {
  // Aside는 SIGTRAP(133), Codex 샌드박스는 SIGABRT(134)로 죽는다(2026-09-20 실측).
  return (
    error?.signal === "SIGTRAP" ||
    error?.signal === "SIGABRT" ||
    error?.code === 133 ||
    error?.code === 134
  );
}

/**
 * 설치된 Lupa가 `--folders`(폴더명 검색)를 지원하는가. 2.0.1부터 있다.
 * 없는 버전에 넘기면 "알 수 없는 옵션"으로 종료 코드 64가 나므로 미리 확인한다.
 */
let folderSupport;
export function supportsFolders() {
  if (folderSupport) return folderSupport;
  folderSupport = helpText().then((text) => text.includes("--folders"));
  return folderSupport;
}

/** `--help` 출력. 두 기능 확인이 같은 호출을 쓰도록 한 번만 실행한다. */
let helpCache;
function helpText() {
  if (helpCache) return helpCache;
  helpCache = (async () => {
    const bin = findLupaSearch();
    if (!bin) throw new LupaNotInstalledError();
    try {
      const { stdout } = await execFileAsync(bin, ["--help"], { timeout: 10_000 });
      return stdout;
    } catch (error) {
      // 샌드박스에 막힌 걸 "기능 미지원"으로 오판하면 "앱을 업데이트하라"는 틀린 안내가 나간다
      if (isSandboxKill(error)) throw new SandboxedLaunchError();
      // --help는 0이 아닌 코드로 끝날 수도 있다 — 출력만 보면 된다
      return error.stdout || "";
    }
  })();
  return helpCache;
}

let contentSupport;
export function supportsContent() {
  if (contentSupport) return contentSupport;
  contentSupport = helpText().then((text) => text.includes("--content"));
  return contentSupport;
}

export class ContentUnsupportedError extends Error {
  constructor() {
    super(
      "설치된 Lupa가 본문 읽기를 지원하지 않습니다. Mac App Store에서 Lupa를 " +
        "2.0 이상으로 업데이트하면 lupa_read를 쓸 수 있습니다. " +
        "그때까지는 lupa_search로 파일을 찾은 뒤 파일을 직접 읽으세요."
    );
    this.name = "ContentUnsupportedError";
  }
}

/**
 * lupa-search를 실행하고 JSON을 돌려준다.
 * @param {string[]} args
 */
export async function runLupa(args) {
  const bin = findLupaSearch();
  if (!bin) throw new LupaNotInstalledError();

  try {
    const { stdout } = await execFileAsync(bin, args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.code === "ETIMEDOUT") {
      throw new Error("검색이 30초 안에 끝나지 않았습니다. 인덱싱이 진행 중일 수 있습니다.");
    }
    if (isSandboxKill(error)) throw new SandboxedLaunchError();
    const known = EXIT_MESSAGES[error.code];
    if (known) throw new Error(known);
    const detail = (error.stderr || error.message || "").trim();
    throw new Error(`lupa-search 실행 실패${detail ? `: ${detail}` : ""}`);
  }
}
