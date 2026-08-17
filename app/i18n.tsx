"use client";

// 语言上下文:layout(服务端读 cookie/Accept-Language)给初始值,SSR 与
// 客户端首帧一致 → 无水合错位。切换即时生效(context 重渲)并写 cookie
// 持久 + 同步 <html lang>。
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DICT } from "../lib/i18n/dict";
import {
  LANG_COOKIE,
  translate,
  type Lang,
  type TParams,
} from "../lib/i18n/core";

interface LangCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (zh: string, params?: TParams) => string;
}

const Ctx = createContext<LangCtx | null>(null);

export function LangProvider({
  initial,
  children,
}: {
  initial: Lang;
  children: ReactNode;
}) {
  const [lang, setLangState] = useState<Lang>(initial);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    document.cookie = `${LANG_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = l === "en" ? "en" : "zh-CN";
  }, []);
  const t = useCallback(
    (zh: string, params?: TParams) => translate(DICT, lang, zh, params),
    [lang],
  );
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLang(): LangCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useLang must be used inside LangProvider");
  return v;
}
