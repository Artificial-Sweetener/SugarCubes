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
"""Versioning helpers for SugarCubes exports."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

try:
    from ..cube_model import (
        CubeDocument,
        looks_like_current_cube_payload,
        looks_like_legacy_cube_payload,
        migrate_legacy_payload,
    )
    from ..cube_model.version_policy import suggest_version as suggest_document_version
except ImportError:
    from cube_model import (
        CubeDocument,
        looks_like_current_cube_payload,
        looks_like_legacy_cube_payload,
        migrate_legacy_payload,
    )
    from cube_model.version_policy import suggest_version as suggest_document_version


@dataclass(frozen=True)
class VersionSuggestion:
    """Describe the semantic-version bump suggested for an export."""

    bump: str
    suggested: str
    reason: str


def suggest_version(
    old_cube: Mapping[str, Any], new_cube: Mapping[str, Any]
) -> VersionSuggestion:
    """Suggest a semantic version based on interface, topology, and config drift."""

    suggestion = suggest_document_version(
        _coerce_document(old_cube), _coerce_document(new_cube)
    )
    return VersionSuggestion(
        bump=suggestion.bump,
        suggested=suggestion.suggested,
        reason=suggestion.reason,
    )


def _coerce_document(value: Mapping[str, Any]) -> CubeDocument:
    """Coerce a persisted payload into the canonical cube document type."""

    if looks_like_current_cube_payload(value):
        return CubeDocument.from_dict(value)
    if looks_like_legacy_cube_payload(value):
        return migrate_legacy_payload(value)
    return CubeDocument.from_dict(value)


def _read_version(cube: Mapping[str, Any]) -> str:
    """Read a trimmed version string from a cube payload."""

    value = cube.get("version")
    if isinstance(value, str):
        return value.strip()
    return ""


def _parse_version(value: str) -> Optional[Tuple[int, int, int]]:
    """Parse a `major.minor.patch` version string when it is complete."""

    if not value:
        return None
    parts = value.strip().split(".")
    if len(parts) < 3:
        return None
    try:
        return (int(parts[0]), int(parts[1]), int(parts[2]))
    except ValueError:
        return None


def _format_version(value: Tuple[int, int, int]) -> str:
    """Format a parsed semantic-version tuple."""

    return f"{value[0]}.{value[1]}.{value[2]}"


def _bump_version(version: Tuple[int, int, int], bump: str) -> Tuple[int, int, int]:
    """Increment the version tuple for the requested semantic bump."""

    major, minor, patch = version
    if bump == "major":
        return (major + 1, 0, 0)
    if bump == "minor":
        return (major, minor + 1, 0)
    return (major, minor, patch + 1)


def _classify_changes(
    old_cube: Mapping[str, Any], new_cube: Mapping[str, Any]
) -> Tuple[str, str]:
    """Classify export drift by interface, topology, then configuration changes."""

    if _interface_signature(old_cube) != _interface_signature(new_cube):
        return "major", "Interface changed"
    if _topology_signature(old_cube) != _topology_signature(new_cube):
        return "minor", "Topology changed"
    if _config_signature(old_cube) != _config_signature(new_cube):
        return "patch", "Configuration changed"
    return "none", "No changes detected"


def _interface_signature(cube: Mapping[str, Any]) -> Tuple[Tuple, Tuple]:
    """Build the interface signature used for major-version decisions."""

    inputs = cube.get("inputs")
    outputs = cube.get("outputs")
    nodes = cube.get("nodes")
    definitions = cube.get("definitions")

    input_entries: List[Tuple[str, str, str, Tuple[str, ...]]] = []
    if isinstance(inputs, Mapping):
        for alias, entry in inputs.items():
            if not isinstance(entry, Mapping):
                continue
            kind = str(entry.get("kind") or "")
            key = str(entry.get("key") or "")
            targets = entry.get("targets")
            types = _resolve_input_types(nodes, definitions, targets)
            input_entries.append((str(alias), kind, key, tuple(types)))
    output_entries: List[Tuple[str, str, str]] = []
    if isinstance(outputs, Mapping) and isinstance(nodes, Mapping):
        for alias, symbol in outputs.items():
            symbol_name = str(symbol)
            class_type = ""
            node = nodes.get(symbol_name)
            if isinstance(node, Mapping):
                class_type = str(node.get("class_type") or "")
            output_type = _resolve_output_type(
                nodes, definitions, symbol_name, str(alias)
            )
            output_entries.append((str(alias), class_type, output_type))

    return tuple(sorted(input_entries)), tuple(sorted(output_entries))


def _topology_signature(cube: Mapping[str, Any]) -> Tuple[Tuple, Tuple]:
    """Build the structural signature used for minor-version decisions."""

    nodes = cube.get("nodes")
    if not isinstance(nodes, Mapping):
        return tuple(), tuple()
    node_entries = tuple(
        sorted(
            (str(symbol), str(entry.get("class_type") or ""))
            for symbol, entry in nodes.items()
            if isinstance(entry, Mapping)
        )
    )
    edges: List[Tuple[str, int, str, str]] = []
    for symbol, entry in nodes.items():
        if not isinstance(entry, Mapping):
            continue
        inputs = entry.get("inputs")
        if not isinstance(inputs, Mapping):
            continue
        for key, value in inputs.items():
            for source, slot in _iter_links(value):
                if source not in nodes:
                    continue
                edges.append((str(source), int(slot), str(symbol), str(key)))
    return node_entries, tuple(sorted(edges))


def _config_signature(cube: Mapping[str, Any]) -> str:
    """Build the configuration-only signature used for patch decisions."""

    nodes = cube.get("nodes")
    metadata = cube.get("metadata")
    description = cube.get("description")

    stripped_nodes: Dict[str, Any] = {}
    if isinstance(nodes, Mapping):
        for symbol, entry in nodes.items():
            if not isinstance(entry, Mapping):
                continue
            inputs = entry.get("inputs")
            if not isinstance(inputs, Mapping):
                continue
            cleaned_inputs: Dict[str, Any] = {}
            for key, value in inputs.items():
                if _is_link(value) or _is_link_list(value):
                    continue
                cleaned_inputs[str(key)] = value
            stripped_nodes[str(symbol)] = {
                "class_type": entry.get("class_type"),
                "inputs": cleaned_inputs,
            }

    clean_metadata: Dict[str, Any] = {}
    if isinstance(metadata, Mapping):
        for key, value in metadata.items():
            if key == "version":
                continue
            clean_metadata[str(key)] = value

    payload = {
        "description": description,
        "metadata": clean_metadata,
        "nodes": stripped_nodes,
    }
    return json.dumps(payload, sort_keys=True, default=str)


def _resolve_input_types(nodes: Any, definitions: Any, targets: Any) -> List[str]:
    """Resolve the normalized input types referenced by binding targets."""

    if not isinstance(targets, Sequence) or not isinstance(nodes, Mapping):
        return []
    resolved: List[str] = []
    for target in targets:
        if not isinstance(target, Sequence) or len(target) < 2:
            continue
        symbol = str(target[0])
        port = target[1]
        node = nodes.get(symbol)
        if not isinstance(node, Mapping):
            continue
        class_type = node.get("class_type")
        if not isinstance(class_type, str):
            continue
        resolved_type = _resolve_input_type(definitions, class_type, port)
        if resolved_type:
            resolved.append(resolved_type)
    return sorted(set(resolved))


def _resolve_input_type(definitions: Any, class_type: str, port: Any) -> str:
    """Resolve one declared input type from the definitions payload."""

    if not isinstance(definitions, Mapping):
        return ""
    definition = definitions.get(class_type)
    if not isinstance(definition, Mapping):
        return ""
    inputs = definition.get("input")
    if not isinstance(inputs, Mapping):
        return ""
    port_name = port if isinstance(port, str) else None
    for section in ("required", "optional", "hidden"):
        section_map = inputs.get(section)
        if not isinstance(section_map, Mapping):
            continue
        if port_name and port_name in section_map:
            return _normalize_type_spec(section_map.get(port_name))
    return ""


def resolve_input_type(definitions: Any, class_type: str, port_name: Any) -> str:
    """Resolve a node input type from definitions."""
    return _resolve_input_type(definitions, class_type, port_name)


def resolve_output_type_by_slot(
    definitions: Any, class_type: str, slot_index: Any
) -> str:
    """Resolve a node output type by slot index."""
    if not isinstance(definitions, Mapping):
        return ""
    definition = definitions.get(class_type)
    if not isinstance(definition, Mapping):
        return ""
    outputs = definition.get("output")
    if isinstance(outputs, Sequence):
        if len(outputs) == 1:
            return _normalize_type_spec(outputs[0])
        if isinstance(slot_index, int) and 0 <= slot_index < len(outputs):
            return _normalize_type_spec(outputs[slot_index])
    return ""


def _resolve_output_type(nodes: Any, definitions: Any, symbol: str, alias: str) -> str:
    """Resolve the declared output type for a serialized output alias."""

    if not isinstance(nodes, Mapping) or not isinstance(definitions, Mapping):
        return ""
    node = nodes.get(symbol)
    if not isinstance(node, Mapping):
        return ""
    class_type = node.get("class_type")
    if not isinstance(class_type, str):
        return ""
    definition = definitions.get(class_type)
    if not isinstance(definition, Mapping):
        return ""
    outputs = definition.get("output")
    if isinstance(outputs, Sequence) and len(outputs) == 1:
        return _normalize_type_spec(outputs[0])
    output_names = definition.get("output_name")
    if isinstance(output_names, Sequence) and alias in output_names:
        try:
            idx = list(output_names).index(alias)
            return resolve_output_type_by_slot(definitions, class_type, idx)
        except ValueError:
            return ""
    return ""


def _normalize_type_spec(value: Any) -> str:
    """Normalize a Comfy type spec into the exported string form."""

    if isinstance(value, (list, tuple)) and value:
        head = value[0]
        return str(head)
    if isinstance(value, str):
        return value
    return ""


def _iter_links(value: Any) -> Iterable[Tuple[str, int]]:
    """Yield link tuples from one serialized input value."""

    if _is_link(value):
        return [(str(value[0]), int(value[1]))]
    if _is_link_list(value):
        links: List[Tuple[str, int]] = []
        for entry in value:
            if _is_link(entry):
                links.append((str(entry[0]), int(entry[1])))
        return links
    return []


def _is_link(value: Any) -> bool:
    """Return whether the value is one serialized node link."""

    if not isinstance(value, list) or len(value) != 2:
        return False
    return isinstance(value[0], str) and isinstance(value[1], int)


def _is_link_list(value: Any) -> bool:
    """Return whether the value is a list of serialized node links."""

    if not isinstance(value, list) or not value:
        return False
    return all(_is_link(entry) for entry in value)
