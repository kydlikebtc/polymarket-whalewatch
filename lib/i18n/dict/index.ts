// 合并字典 —— 分片按页面拆(并行施工零冲突),此处唯一汇合点。
// 重复键后导入者胜;卫生规则见 lib/i18n/dict.test.ts。
import { DICT_COMMON } from "./common";
import { DICT_HOME } from "./home";
import { DICT_ALERTS } from "./alerts";
import { DICT_CONSENSUS } from "./consensus";
import { DICT_ACCUMULATION } from "./accumulation";
import { DICT_DISCOVERY } from "./discovery";
import { DICT_FOLLOW } from "./follow";
import { DICT_DEEP } from "./deep";
import { DICT_WALLET } from "./wallet";
import { DICT_MARKET } from "./market";
import { DICT_GLOSSARY } from "./glossary";
import { DICT_MISC } from "./misc";
import { DICT_STATUS } from "./status";
import { DICT_PULSE } from "./pulse";
import { DICT_CALIBRATION } from "./calibration";
import { DICT_SELFTEST } from "./selftest";

export const DICT: Record<string, string> = {
  ...DICT_COMMON,
  ...DICT_HOME,
  ...DICT_ALERTS,
  ...DICT_CONSENSUS,
  ...DICT_ACCUMULATION,
  ...DICT_DISCOVERY,
  ...DICT_FOLLOW,
  ...DICT_DEEP,
  ...DICT_WALLET,
  ...DICT_MARKET,
  ...DICT_GLOSSARY,
  ...DICT_MISC,
  ...DICT_STATUS,
  ...DICT_PULSE,
  ...DICT_CALIBRATION,
  ...DICT_SELFTEST,
};
