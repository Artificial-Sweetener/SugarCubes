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
 * Own the SugarCubes graph integration layer in `web/comfyui/ui/graph/DirtyTracker.js`.
 */

import { getGraphGroups, getGraphNodes } from './GraphQuery.js';
import { buildIdLookup, resolveInstanceAnchorFromNodes } from './DirtySnapshotter.js';
import {
  computeCosmeticHash,
  computeImplementationHash,
  computeSurfaceHash,
  computeSurfaceValuesHash,
} from './DirtyHasher.js';
import { DirtyStateService } from './DirtyStateService.js';
import { DirtyStateApplier } from './DirtyStateApplier.js';
import { getGroupSugarcubes } from './GroupMetadata.js';
import { buildCubeDefinitionKey } from '../core/CubeDefinitionKey.js';

/**
 * Coordinate dirty tracker behavior for the SugarCubes UI.
 */
export class DirtyTracker {
  constructor({ logger, baselineStore, baselineResolver, evaluator, stateApplier } = {}) {
    this.instances = new Map();
    this.dirtyCubeIds = new Set();
    this.saveableCubeIds = new Set();
    this.listeners = new Set();
    this.logger = logger || null;
    this.baselineStore = baselineStore;
    this.baselineResolver = baselineResolver;
    this.evaluator = evaluator || new DirtyStateService();
    this.stateApplier =
      stateApplier ||
      new DirtyStateApplier({
        tracker: this,
      });
    this.warnedMissingSymbols = new Set();
  }

  onChange(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getDirtyCubeIds() {
    return new Set(this.dirtyCubeIds);
  }

  getImplementationDirtyCubeIds() {
    return new Set(this.dirtyCubeIds);
  }

  getSaveableCubeIds() {
    return new Set(this.saveableCubeIds);
  }

  hasDefinitionBaseline(definitionKey) {
    const hash = this.baselineStore?.getDefinitionHash(definitionKey) || null;
    if (!hash) {
      return false;
    }
    const status = this.baselineStore?.getDefinitionStatus(definitionKey) || null;
    return status == null || status === 'ready';
  }

  resolveGroupSnapshotForLocalHash(group, definitionKey) {
    return this.hasDefinitionBaseline(definitionKey) ? null : group;
  }

  resolveSurfaceBaselineHash(metadata) {
    const surface = metadata?.surface || null;
    const activeValues =
      metadata?.active_flavor_values && typeof metadata.active_flavor_values === 'object'
        ? metadata.active_flavor_values
        : {};
    if (!Array.isArray(surface?.controls) || !surface.controls.length) {
      return null;
    }
    return computeSurfaceValuesHash(surface, activeValues);
  }

  refresh({ graph, knownCubeIds } = {}) {
    if (!graph) {
      return { dirtyCubeIds: new Set() };
    }
    const now = Date.now();
    const hasKnown = knownCubeIds != null;
    const knownSet =
      knownCubeIds instanceof Set
        ? knownCubeIds
        : new Set(Array.isArray(knownCubeIds) ? knownCubeIds : []);
    const groups = getGraphGroups(graph);
    const activeInstanceIds = new Set();

    for (const group of groups) {
      const metadata = getGroupSugarcubes(group);
      if (!metadata?.managed || !metadata.instance_id || !metadata.cube_id) {
        continue;
      }
      const nodeIds = Array.isArray(metadata.nodes) ? metadata.nodes : [];
      const markerIds = Array.isArray(metadata.markers)
        ? metadata.markers
        : Object.values(metadata.markers || {}).flatMap((value) =>
            Array.isArray(value) ? value : [],
          );
      const instanceId = metadata.instance_id;
      const definitionKey = resolveDefinitionKey(metadata);
      const localGroup = this.resolveGroupSnapshotForLocalHash(group, definitionKey);
      const nodeById = new Map(
        getGraphNodes(graph)
          .filter((node) => node?.id != null)
          .map((node) => [String(node.id), node]),
      );
      const ids = new Set([...nodeIds.map(String), ...markerIds.map(String)]);
      const anchor = resolveInstanceAnchorFromNodes(nodeById, ids);
      const { lookup: idLookup, missing: missingSymbols } = buildIdLookup(nodeById, ids);
      const isKnown = !hasKnown || knownSet.has(metadata.cube_id);
      const resolution = this.baselineResolver.resolve({
        cubeId: metadata.cube_id,
        definitionKey,
        instanceId,
        missingSymbols,
      });
      const useDefinition = resolution.useDefinition;
      const implementationCurrentHash = computeImplementationHash(
        graph,
        nodeIds,
        markerIds,
        anchor,
        metadata.surface || null,
        useDefinition
          ? {
              idLookup,
              useSymbols: true,
              useInputNames: true,
              stripSugarcubesProperties: true,
            }
          : {
              useSymbols: false,
              useInputNames: false,
            },
      );
      const cosmeticCurrentHash = computeCosmeticHash(
        graph,
        nodeIds,
        markerIds,
        anchor,
        localGroup || group,
      );
      const surfaceCurrentHash = computeSurfaceHash(graph, nodeIds, metadata.surface || null);
      const previous = this.instances.get(instanceId);
      let implementationBaselineHash = resolution.baselineHash;
      if (!implementationBaselineHash && !useDefinition) {
        this.baselineStore?.setLocalImplementationHash(instanceId, implementationCurrentHash);
        implementationBaselineHash = implementationCurrentHash;
      }
      let cosmeticBaselineHash = this.baselineStore?.getLocalCosmeticHash(instanceId) || null;
      if (!cosmeticBaselineHash) {
        this.baselineStore?.setLocalCosmeticHash(instanceId, cosmeticCurrentHash);
        cosmeticBaselineHash = cosmeticCurrentHash;
      }
      let surfaceBaselineHash = this.resolveSurfaceBaselineHash(metadata);
      if (!surfaceBaselineHash) {
        surfaceBaselineHash = surfaceCurrentHash;
      }
      if (
        !useDefinition &&
        !this.baselineStore?.getLocalImplementationHash(instanceId) &&
        metadata.dirty &&
        metadata.dirty_at
      ) {
        this.baselineStore?.setLocalImplementationHash(instanceId, implementationCurrentHash);
        implementationBaselineHash = implementationCurrentHash;
      }
      const evaluation = this.evaluator.evaluate({
        implementationCurrentHash,
        implementationBaselineHash,
        cosmeticCurrentHash,
        cosmeticBaselineHash,
        surfaceCurrentHash,
        surfaceBaselineHash,
        isKnown,
        missingSymbols: useDefinition ? missingSymbols : false,
        previousDirtyAt: previous?.dirtyAt || null,
      });
      const initializedAt = previous?.initializedAt ?? now;

      this.stateApplier.applyInstanceState({
        group,
        metadata,
        instanceId,
        cubeId: metadata.cube_id,
        definitionKey,
        implementationBaselineHash,
        implementationCurrentHash,
        cosmeticBaselineHash,
        cosmeticCurrentHash,
        surfaceBaselineHash,
        surfaceCurrentHash,
        dirty: evaluation.implementationDirty,
        dirtyAt: evaluation.dirtyAt,
        implementationDirty: evaluation.implementationDirty,
        implementationReasons: evaluation.implementationReasons,
        cosmeticDirty: evaluation.cosmeticDirty,
        surfaceValuesChanged: evaluation.surfaceValuesChanged,
        hasSaveableChanges: evaluation.implementationDirty,
        initializedAt,
      });
      activeInstanceIds.add(instanceId);

      if (
        evaluation.implementationReasons.includes('missing-symbols') &&
        this.logger &&
        !this.warnedMissingSymbols.has(instanceId)
      ) {
        this.warnedMissingSymbols.add(instanceId);
        this.logger.warn(
          'SugarCubes: symbol metadata missing; instance marked dirty',
          metadata.cube_id,
        );
      }
    }

    for (const instanceId of Array.from(this.instances.keys())) {
      if (!activeInstanceIds.has(instanceId)) {
        this.instances.delete(instanceId);
        this.warnedMissingSymbols.delete(instanceId);
      }
    }
    this.baselineStore?.pruneLocalBaselines(activeInstanceIds);

    this.stateApplier.finalize();
    return { dirtyCubeIds: new Set(this.dirtyCubeIds) };
  }

  markClean({ graph, cubeIds } = {}) {
    if (!graph || !Array.isArray(cubeIds) || !cubeIds.length) {
      return;
    }
    const cubeIdSet = new Set(cubeIds);
    const groups = getGraphGroups(graph);
    for (const group of groups) {
      const metadata = getGroupSugarcubes(group);
      if (!metadata?.managed || !metadata.instance_id || !metadata.cube_id) {
        continue;
      }
      if (!cubeIdSet.has(metadata.cube_id)) {
        continue;
      }
      const nodeIds = Array.isArray(metadata.nodes) ? metadata.nodes : [];
      const markerIds = Array.isArray(metadata.markers)
        ? metadata.markers
        : Object.values(metadata.markers || {}).flatMap((value) =>
            Array.isArray(value) ? value : [],
          );
      const ids = new Set([...nodeIds.map(String), ...markerIds.map(String)]);
      const nodeById = new Map(
        getGraphNodes(graph)
          .filter((node) => node?.id != null)
          .map((node) => [String(node.id), node]),
      );
      const anchor = resolveInstanceAnchorFromNodes(nodeById, ids);
      const implementationCurrentHash = computeImplementationHash(
        graph,
        nodeIds,
        markerIds,
        anchor,
        metadata.surface || null,
        {
          useSymbols: false,
          useInputNames: false,
        },
      );
      const cosmeticCurrentHash = computeCosmeticHash(graph, nodeIds, markerIds, anchor, group);
      this.baselineStore?.setLocalImplementationHash(
        metadata.instance_id,
        implementationCurrentHash,
      );
      this.baselineStore?.setLocalCosmeticHash(metadata.instance_id, cosmeticCurrentHash);
      this.stateApplier.applyInstanceState({
        group,
        metadata,
        instanceId: metadata.instance_id,
        cubeId: metadata.cube_id,
        implementationBaselineHash: implementationCurrentHash,
        implementationCurrentHash,
        cosmeticBaselineHash: cosmeticCurrentHash,
        cosmeticCurrentHash,
        surfaceBaselineHash: this.resolveSurfaceBaselineHash(metadata),
        surfaceCurrentHash: computeSurfaceHash(graph, nodeIds, metadata.surface || null),
        dirty: false,
        dirtyAt: null,
        implementationDirty: false,
        implementationReasons: [],
        cosmeticDirty: false,
        surfaceValuesChanged: false,
        hasSaveableChanges: false,
        initializedAt: Date.now(),
      });
    }
    this.stateApplier.finalize();
  }

  markLocalBaseline({ graph, cubeIds } = {}) {
    if (!graph || !Array.isArray(cubeIds) || !cubeIds.length) {
      return;
    }
    const cubeIdSet = new Set(cubeIds);
    const groups = getGraphGroups(graph);
    for (const group of groups) {
      const metadata = getGroupSugarcubes(group);
      if (!metadata?.managed || !metadata.instance_id || !metadata.cube_id) {
        continue;
      }
      if (!cubeIdSet.has(metadata.cube_id)) {
        continue;
      }
      const nodeIds = Array.isArray(metadata.nodes) ? metadata.nodes : [];
      const markerIds = Array.isArray(metadata.markers)
        ? metadata.markers
        : Object.values(metadata.markers || {}).flatMap((value) =>
            Array.isArray(value) ? value : [],
          );
      const ids = new Set([...nodeIds.map(String), ...markerIds.map(String)]);
      const nodeById = new Map(
        getGraphNodes(graph)
          .filter((node) => node?.id != null)
          .map((node) => [String(node.id), node]),
      );
      const anchor = resolveInstanceAnchorFromNodes(nodeById, ids);
      const implementationCurrentHash = computeImplementationHash(
        graph,
        nodeIds,
        markerIds,
        anchor,
        metadata.surface || null,
        {
          useSymbols: false,
          useInputNames: false,
        },
      );
      const cosmeticCurrentHash = computeCosmeticHash(graph, nodeIds, markerIds, anchor, group);
      this.baselineStore?.setLocalImplementationHash(
        metadata.instance_id,
        implementationCurrentHash,
      );
      this.baselineStore?.setLocalCosmeticHash(metadata.instance_id, cosmeticCurrentHash);
      const existing = this.instances.get(metadata.instance_id);
      if (existing) {
        this.instances.set(metadata.instance_id, {
          ...existing,
          baselineHash: implementationCurrentHash,
          currentHash: implementationCurrentHash,
          implementationBaselineHash: implementationCurrentHash,
          implementationCurrentHash,
          cosmeticBaselineHash: cosmeticCurrentHash,
          cosmeticCurrentHash,
          surfaceBaselineHash: this.resolveSurfaceBaselineHash(metadata),
          surfaceCurrentHash: computeSurfaceHash(graph, nodeIds, metadata.surface || null),
        });
      }
    }
  }

  updateDirtyCubeIds() {
    const nextDirty = new Set();
    const nextSaveable = new Set();
    for (const entry of this.instances.values()) {
      if (entry?.hasSaveableChanges && entry.cubeId) {
        nextSaveable.add(entry.cubeId);
      }
      if (entry?.implementationDirty && entry.cubeId) {
        nextDirty.add(entry.cubeId);
      }
    }
    this.saveableCubeIds = nextSaveable;
    const previous = this.dirtyCubeIds;
    let changed = nextDirty.size !== previous.size;
    if (!changed) {
      for (const value of nextDirty) {
        if (!previous.has(value)) {
          changed = true;
          break;
        }
      }
    }
    if (changed) {
      this.dirtyCubeIds = nextDirty;
      for (const listener of this.listeners) {
        try {
          listener(new Set(this.dirtyCubeIds));
        } catch (_error) {
          // ignore listener errors
        }
      }
    }
  }
}

function resolveDefinitionKey(metadata) {
  const existing =
    typeof metadata?.cube_definition_key === 'string' ? metadata.cube_definition_key.trim() : '';
  if (existing) {
    return existing;
  }
  return buildCubeDefinitionKey(metadata?.cube_id, metadata?.cube_version);
}
