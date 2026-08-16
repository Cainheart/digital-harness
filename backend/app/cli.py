from __future__ import annotations

import argparse
import os
from pathlib import Path

import uvicorn


def main() -> None:
    """解析本地控制面启动参数，并交给 Uvicorn 运行。"""
    parser = argparse.ArgumentParser(description="Run the Digital Harness control plane")
    parser.add_argument("--persistent-root", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    os.environ["DIGITAL_HARNESS_PERSISTENT_ROOT"] = str(args.persistent_root.resolve())
    uvicorn.run("app.main:app", host="127.0.0.1", port=args.port, factory=False)


if __name__ == "__main__":
    main()
