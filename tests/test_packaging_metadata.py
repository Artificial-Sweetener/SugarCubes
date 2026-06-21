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
"""Validate package metadata required for Comfy Registry publication."""

from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any

_REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_pyproject() -> dict[str, Any]:
    """Read the authoritative Python and registry metadata."""

    return tomllib.loads((_REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))


def test_comfy_registry_metadata_matches_public_project_identity() -> None:
    """Keep immutable registry identifiers aligned before first publication."""

    metadata = _load_pyproject()

    assert metadata["project"]["name"] == "SugarCubes"
    assert metadata["project"]["urls"] == {
        "Repository": "https://github.com/Artificial-Sweetener/SugarCubes",
        "Bug Tracker": "https://github.com/Artificial-Sweetener/SugarCubes/issues",
    }
    assert metadata["tool"]["comfy"] == {
        "PublisherId": "artificialsweetener",
        "DisplayName": "SugarCubes",
        "Icon": "",
        "includes": [],
    }


def test_runtime_identity_uses_canonical_sugarcubes_distribution_name() -> None:
    """Runtime version reporting should never use legacy package identities."""

    backend_source = (_REPO_ROOT / "backend" / "__init__.py").read_text(
        encoding="utf-8"
    )
    cube_library_source = (
        _REPO_ROOT / "backend" / "services" / "cube_library_service.py"
    ).read_text(encoding="utf-8")
    dependency_versions_source = (
        _REPO_ROOT / "backend" / "services" / "dependency_versions.py"
    ).read_text(encoding="utf-8")

    assert '_DISTRIBUTION_NAME = "SugarCubes"' in backend_source
    assert "_FALLBACK_VERSION" not in backend_source
    assert 'frozenset({"sugarcubes"})' in cube_library_source
    assert 'frozenset({"sugarcubes"})' in dependency_versions_source
