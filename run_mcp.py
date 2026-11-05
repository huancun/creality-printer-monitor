#!/usr/bin/env python3
"""Start the stdio MCP server directly from the source checkout."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent / "src"))

from printermonitor.mcp_server import main


if __name__ == "__main__":
    main()
