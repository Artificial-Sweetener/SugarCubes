//    SugarCubes - composable workflow units for ComfyUI
//    Copyright (C) 2026  Artificial Sweetener and contributors
//
//    This program is free software: you can redistribute it and/or modify
//    it under the terms of the GNU Affero General Public License as published by
//    the Free Software Foundation, either version 3 of the License, or
//    (at your option) any later version.
//
//    This program is distributed in the hope that it will be useful,
//    but WITHOUT ANY WARRANTY; without even the implied warranty of
//    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//    GNU Affero General Public License for more details.
//
//    You should have received a copy of the GNU Affero General Public License
//    along with this program.  If not, see <https://www.gnu.org/licenses/>.
/**
 * Own the SugarCubes graph integration layer in `web/comfyui/ui/graph/Bounds.js`.
 */

/**
 * Read node bounds.
 */
export function readNodeBounds(node) {
  if (!node) return null;
  if (typeof node.getBounding === 'function') {
    try {
      const bounds = node.getBounding();
      if (Array.isArray(bounds) && bounds.length >= 4) {
        return bounds;
      }
    } catch (_error) {
      return null;
    }
  }
  const pos = node?.pos;
  const size = node?.size;
  const posReadable = (Array.isArray(pos) || ArrayBuffer.isView(pos)) && (pos?.length || 0) >= 2;
  const sizeReadable =
    (Array.isArray(size) || ArrayBuffer.isView(size)) && (size?.length || 0) >= 2;
  if (posReadable && sizeReadable) {
    return [node.pos[0], node.pos[1], node.size[0], node.size[1]];
  }
  return null;
}

/**
 * Read group bounds.
 */
export function readGroupBounds(group) {
  if (!group) return null;
  const pos = group.pos;
  const size = group.size;
  const posOk = Array.isArray(pos) || ArrayBuffer.isView(pos);
  const sizeOk = Array.isArray(size) || ArrayBuffer.isView(size);
  if (posOk && sizeOk && pos.length >= 2 && size.length >= 2) {
    return [pos[0], pos[1], size[0], size[1]];
  }
  const bounding = group._bounding;
  if (
    bounding &&
    (Array.isArray(bounding) || ArrayBuffer.isView(bounding)) &&
    bounding.length >= 4
  ) {
    return [bounding[0], bounding[1], bounding[2], bounding[3]];
  }
  return null;
}

/**
 * Return whether point in bounds.
 */
export function isPointInBounds(point, bounds) {
  if (!point || !bounds) return false;
  const [x, y] = point;
  const [bx, by, bw, bh] = bounds;
  return x >= bx && x <= bx + bw && y >= by && y <= by + bh;
}

/**
 * Get node center.
 */
export function getNodeCenter(node) {
  if (Array.isArray(node?.pos) && Array.isArray(node?.size)) {
    return [node.pos[0] + node.size[0] / 2, node.pos[1] + node.size[1] / 2];
  }
  const bounds = readNodeBounds(node);
  if (!bounds) return null;
  return [bounds[0] + bounds[2] / 2, bounds[1] + bounds[3] / 2];
}
