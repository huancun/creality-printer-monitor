#!/usr/bin/env python3
"""Start the Printer Monitor directly from the source checkout."""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent / "src"))

from printermonitor import main  # type: ignore[import-not-found]  # noqa: E402


if __name__ == "__main__":
    main()
