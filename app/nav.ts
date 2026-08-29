// 顶栏导航数据 —— 从 ui.tsx 抽出的纯数据模块(client-safe,无 JSX):
// TopNav 渲染它,/guide 的覆盖闸测试消费它(NAV ⊆ 说明书,新页面进导航
// 漏写说明书直接红)。ui.tsx 里那份信息架构注释仍是权威,此处只放数据。
export type NavItem = { href: string; label: string };
export type NavEntry = NavItem | { label: string; items: NavItem[] };

// 分区按数据性质递进:客观行情 → 我们识别的主体 → 我们自己的产出与验证。
//   市场    = 同一批成交的不同切片(全市场流 / 按钱包聚合 / 按单市场)
//   聪明钱  = 谁值得跟(发现) + 他们在做什么(共识/分歧) + 访客自己(自测)
//   信号与战绩 = 本工具发了什么信号、策略跑成什么样、对外公开战绩
// 24h 扫描是最高频入口故不折叠;说明是低频但要随时可达,同样直达。
export const NAV: NavEntry[] = [
  { href: "/", label: "24h 扫描" },
  {
    label: "市场",
    items: [
      { href: "/accumulation", label: "拆单累计" },
      { href: "/market", label: "市场卡" },
      { href: "/pulse", label: "市场脉搏" },
      { href: "/calibration", label: "市场校准" },
    ],
  },
  {
    label: "聪明钱",
    items: [
      { href: "/consensus", label: "共识 / 分歧" },
      { href: "/discovery", label: "聪明钱发现" },
      { href: "/selftest", label: "聪明钱自测" },
    ],
  },
  {
    label: "信号与战绩",
    items: [
      { href: "/alerts", label: "实时告警" },
      { href: "/follow", label: "策略中心" },
      { href: "/record", label: "信号战绩" },
    ],
  },
  { href: "/glossary", label: "说明" },
];
