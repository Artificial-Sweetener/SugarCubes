#    SugarCubes - composable workflow units for ComfyUI
#    Copyright (C) 2026  Artificial Sweetener and contributors
#
#    This program is free software: you can redistribute it and/or modify
#    it under the terms of the GNU Affero General Public License as published by
#    the Free Software Foundation, either version 3 of the License, or
#    (at your option) any later version.
#
#    This program is distributed in the hope that it will be useful,
#    but WITHOUT ANY WARRANTY; without even the implied warranty of
#    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#    GNU Affero General Public License for more details.
#
#    You should have received a copy of the GNU Affero General Public License
#    along with this program.  If not, see <https://www.gnu.org/licenses/>.
"""Offline maintenance CLI diagnostics tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from sugarcubes.backend import maintenance


def test_maintenance_crash_writes_structured_diagnostic(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    tmp_path: Path,
) -> None:
    """Unexpected maintenance crashes should still produce machine-readable JSON."""

    def fail_build_services(*args: object, **kwargs: object) -> object:
        """Raise the unexpected failure exercised by this test."""

        _ = args, kwargs
        raise RuntimeError("boom")

    monkeypatch.setattr(maintenance, "build_backend_services", fail_build_services)

    exit_code = maintenance.main(
        ["cube-deps", "sync-and-check", "--workspace", str(tmp_path)]
    )

    payload = json.loads(capsys.readouterr().out)
    assert exit_code == 1
    assert payload["error"] == "SugarCubes maintenance crashed"
    assert payload["diagnostics"][0]["code"] == "maintenance_crashed"
    assert payload["diagnostics"][0]["severity"] == "error"
