import { digestPreimage } from "./digestPreimage";

// 存证链的**复算侧** —— 把「理论上可验证」变成「一条命令 / 一个按钮」。
//
// 此前的状态:每日摘要消息里写着「按 id 升序复算 sha256 即可验证」,而仓库里
// 没有任何验证工具,公开导出 CSV 里**甚至没有 id 这一列**(链却是拿 id 做
// 输入的)。也就是说,那句承诺当时任何人都执行不了。本模块 + CSV 的
// signal_id 列 + /api/record 的 digests[] 三件一起,才让它成为真的。
//
// 分层与全仓一致:这里是**纯核心**,不碰 DB、不碰网络、连 sha256 都是注入的
// —— Node 脚本走 crypto,/record 的验证按钮走浏览器 WebCrypto。两处共用同一
// 份判定,自然不会漂移;preimage 更是直接取自零依赖的 lib/digestPreimage,
// 与生成侧同一个函数。两边各写一遍字符串拼接,迟早有一处改了分隔符,而那种
// 漂移会伪装成「存证验证失败」—— 把可信度工件本身变成噪音,是这里最该防的
// 故障。
//
// 本模块**必须保持浏览器可打包**:只依赖 digestPreimage(零 import),不得
// 引入 node:crypto 或任何碰 DB / 投递栈的模块。

/** 复算输入的一行(来自公开 CSV)。entryPrice 用**原始字段文本**,见下。 */
export interface VerifyRow {
  id: number;
  strategyName: string;
  conditionId: string;
  outcome: string;
  emittedAt: number;
  /**
   * CSV 里 entry_price 的原文:空串 = 无入场价。
   *
   * 刻意不先 parse 成 number 再回填:生成侧写 CSV 用的就是 `String(number)`,
   * 直接拿原文进 preimage 是零转换的等价路径,不给浮点字符串化留任何缝隙。
   */
  entryPriceRaw: string;
}

/** 公开的逐日存证行(来自 /api/record 的 digests[])。 */
export interface VerifyDigest {
  day: string;
  digest: string;
  prev: string;
  count: number;
}

export type VerifyStatus =
  /** 行数一致且复算相符。 */
  | "ok"
  /** 行数一致但摘要对不上 —— 内容被改过。 */
  | "tampered"
  /** 导出里的行**少于**摘要记录 —— 行被删掉了,这是要报的那个方向。 */
  | "missing-rows"
  /** 导出里的行多于摘要记录 —— 多为「摘要算完之后才投递成功」的良性漂移。 */
  | "extra-rows";

export interface VerifyDayResult {
  day: string;
  status: VerifyStatus;
  /** 公开摘要值。 */
  expected: string;
  /** 用导出数据复算出的值。 */
  actual: string;
  digestCount: number;
  exportCount: number;
  /** 与前一条存证行的链接是否连得上;null = 没有前一条可比。 */
  linked: boolean | null;
}

export interface VerifySummary {
  days: VerifyDayResult[];
  ok: number;
  tampered: number;
  missingRows: number;
  extraRows: number;
  brokenLinks: number;
  /** 全绿 = 每一天都 ok 且链接都连得上。 */
  allOk: boolean;
}

/**
 * WebCrypto 版 sha256 → hex。浏览器与 Node 18+ 都有 `globalThis.crypto.subtle`,
 * 所以同一个函数在 /record 的验证按钮与测试里跑的是同一条路径 —— 组件里另写
 * 一份就等于那份永远没测过,而它恰好是整条验证链上唯一碰加密的地方。
 */
export async function webcryptoSha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const DAY_SEC = 86_400;

const dayStartOf = (day: string): number =>
  Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);

/**
 * 逐日复算。
 *
 * @param rows    公开导出的全部已发布信号(顺序无所谓,内部按 id 升序排)
 * @param digests 公开的逐日存证行(顺序无所谓,内部按 day 升序排)
 * @param hash    sha256 → hex。Node: crypto;浏览器: WebCrypto。
 */
export async function verifyDigestDays(
  rows: VerifyRow[],
  digests: VerifyDigest[],
  hash: (s: string) => Promise<string>,
): Promise<VerifySummary> {
  const byDay = [...digests].sort((a, b) => a.day.localeCompare(b.day));
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const out: VerifyDayResult[] = [];
  for (let i = 0; i < byDay.length; i++) {
    const d = byDay[i];
    const from = dayStartOf(d.day);
    const dayRows = sorted.filter(
      (r) => r.emittedAt >= from && r.emittedAt < from + DAY_SEC,
    );
    let h = d.prev;
    for (const r of dayRows) {
      h = await hash(
        digestPreimage(h, {
          id: r.id,
          strategyName: r.strategyName,
          conditionId: r.conditionId,
          outcome: r.outcome,
          emittedAt: r.emittedAt,
          entryPrice: r.entryPriceRaw === "" ? null : r.entryPriceRaw,
        }),
      );
    }
    // 判定顺序有意义:**先看行数**。行数对不上时摘要必然也对不上,而
    // 「少了几行」与「内容被改」是完全不同的两件事,报成后者会误导。
    const status: VerifyStatus =
      dayRows.length < d.count
        ? "missing-rows"
        : dayRows.length > d.count
          ? "extra-rows"
          : h === d.digest
            ? "ok"
            : "tampered";
    out.push({
      day: d.day,
      status,
      expected: d.digest,
      actual: h,
      digestCount: d.count,
      exportCount: dayRows.length,
      // 链接比的是**表里的上一条**而不是日历前一天:引擎停过机就会缺日,
      // 那不是断链。
      linked: i === 0 ? null : byDay[i - 1].digest === d.prev,
    });
  }
  return {
    days: out,
    ok: out.filter((r) => r.status === "ok").length,
    tampered: out.filter((r) => r.status === "tampered").length,
    missingRows: out.filter((r) => r.status === "missing-rows").length,
    extraRows: out.filter((r) => r.status === "extra-rows").length,
    brokenLinks: out.filter((r) => r.linked === false).length,
    allOk: out.every((r) => r.status === "ok" && r.linked !== false),
  };
}

// --- 公开 CSV 解析 --------------------------------------------------------
// 只解析验证需要的五列,按**列名**定位(列序会变,名字不会 —— signal_id
// 就是 2026-09-07 追加到末尾的)。RFC 4180 引号规则与 datasetExport.csvField
// 对称。

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/**
 * 公开导出 CSV → 复算行。`#` 注释行与空行跳过,首个非注释行是列头。
 *
 * 缺 `signal_id` 列时抛 —— 那是 2026-09-07 之前的旧导出,链**用不了它验证**
 * (id 是 preimage 的输入)。这种情况必须明确失败,不能静默给出一堆
 * 「对不上」,那会把工具本身的缺列问题读成篡改。
 */
export function parseRecordCsv(text: string): VerifyRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l !== "" && !l.startsWith("#"));
  if (lines.length === 0) return [];
  const head = parseCsvLine(lines[0]);
  const at = (name: string): number => head.indexOf(name);
  const iId = at("signal_id");
  const iEmitted = at("emitted_at_utc");
  const iName = at("strategy_name");
  const iCid = at("condition_id");
  const iOutcome = at("outcome");
  const iPrice = at("entry_price");
  if (iId < 0) {
    throw new Error(
      "这份 CSV 没有 signal_id 列(2026-09-07 之前的导出)—— 链以 id 为输入,缺了它无法复算",
    );
  }
  for (const [n, i] of [
    ["emitted_at_utc", iEmitted],
    ["strategy_name", iName],
    ["condition_id", iCid],
    ["outcome", iOutcome],
    ["entry_price", iPrice],
  ] as const) {
    if (i < 0) throw new Error(`CSV 缺少必需列 ${n}`);
  }
  const out: VerifyRow[] = [];
  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line);
    const id = Number(f[iId]);
    const emittedAt = Math.floor(Date.parse(f[iEmitted]) / 1000);
    if (!Number.isFinite(id) || !Number.isFinite(emittedAt)) continue;
    out.push({
      id,
      strategyName: f[iName] ?? "",
      conditionId: f[iCid] ?? "",
      outcome: f[iOutcome] ?? "",
      emittedAt,
      entryPriceRaw: f[iPrice] ?? "",
    });
  }
  return out;
}
