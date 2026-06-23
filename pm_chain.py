#!/usr/bin/env python3
"""链上查询助手:Polygon JSON-RPC 故障切换 + keccak topic0 + 日志取样。

设计目标(站在调试者角度):每个 RPC 调用都打印用到的端点与原始错误,
便于定位是节点限流、范围超限还是合约无活动。
"""

import json
import sys
import time
import urllib.request
from eth_hash.auto import keccak

RPCS = [
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.drpc.org",
    "https://1rpc.io/matic",
]


def rpc(method, params, _tries=3):
    """对多个端点轮询调用,返回 result;失败抛出最后一个错误。"""
    last_err = None
    for url in RPCS:
        for attempt in range(_tries):
            try:
                payload = json.dumps(
                    {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}
                ).encode()
                req = urllib.request.Request(
                    url,
                    data=payload,
                    headers={
                        "Content-Type": "application/json",
                        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
                        "Accept": "application/json",
                    },
                )
                with urllib.request.urlopen(req, timeout=25) as resp:
                    body = json.loads(resp.read())
                if "error" in body:
                    last_err = f"{url}: {body['error']}"
                    # 范围/限流类错误换端点重试
                    time.sleep(0.4)
                    continue
                return body["result"]
            except Exception as e:  # noqa: BLE001
                last_err = f"{url}: {e!r}"
                time.sleep(0.4)
    raise RuntimeError(f"all RPC failed for {method}: {last_err}")


def topic0(sig: str) -> str:
    return "0x" + keccak(sig.encode()).hex()


def hexint(x) -> int:
    return int(x, 16) if isinstance(x, str) else int(x)


if __name__ == "__main__":
    # 自检:打印当前区块 + 几个事件签名的 topic0
    bn = hexint(rpc("eth_blockNumber", []))
    print(f"chainId={hexint(rpc('eth_chainId', []))} latestBlock={bn}")
    sigs = [
        "OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)",
        "OrdersMatched(bytes32,address,uint256,uint256,uint256,uint256)",
    ]
    for s in sigs:
        print(f"{topic0(s)}  {s}")
