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
 * Own the SugarCubes UI orchestration layer in `web/comfyui/ui/CubeActionService.js`.
 */

import {
  isCanonicalCubeId,
  normalizeDefaultAliasTitle,
  suggestCanonicalCubePath,
} from './core/CubeId.js';
import {
  DEFAULT_TARGET_MODEL,
  defaultSupportedModelsForTarget,
  deriveRouteFromCubeId,
  deriveTargetModelFromCubeId,
  normalizeCubeRoute,
  normalizeSupportedModels,
  normalizeTargetModel,
} from './core/ModelTargets.js';
import {
  isCubeMarkerType,
  updateMarkersForCubeId,
  updateMarkersForIds,
} from './graph/CubeMarkers.js';
import { resolveNewInstanceBounds } from './graph/CubeBounds.js';
import { InstanceBuilder } from './graph/InstanceBuilder.js';
import { buildLinkIndex, getGraphGroups, getGraphNodes } from './graph/GraphQuery.js';
import { getGroupSugarcubes, setGroupSugarcubes } from './graph/GroupMetadata.js';
import { readWidgetValue, writeWidgetValue } from './graph/Markers.js';
import { normalizeSubgraphPayload } from './graph/SubgraphSerialization.js';
import {
  CURRENT_REVISION_REF,
  buildCubeDefinitionKey,
  isCurrentRevisionRef,
  normalizeCubeVersion,
  normalizeRevisionRef,
} from './core/CubeDefinitionKey.js';

const CUBE_AUTHOR_PROFILE_KEY = 'sugarcubes.author_profile';
const CREATE_CANDIDATE_MARKER_TYPES = new Set(['SugarCubes.CubeInput', 'SugarCubes.CubeOutput']);
const DEFAULT_LOCAL_CREATE_DESTINATION = Object.freeze({
  key: 'local/personal',
  sourceKind: 'local',
  namespace: 'personal',
  label: 'local',
  detail: 'personal',
  writable: true,
});
const CREATE_PACK_DESTINATION_ACTION = Object.freeze({
  key: 'new-pack',
  action: 'create-pack',
  label: 'New pack...',
  detail: 'Create a writable cube pack',
});
const STALE_SAVE_MODE_LATEST = 'latest';

/**
 * Coordinate cube action service behavior for the SugarCubes UI.
 */
export class CubeActionService {
  constructor({
    adapter,
    api,
    storage,
    toast,
    instanceManager,
    dirtyManager,
    cubeBrowser,
    versionDialog,
    dialogs,
    flavorService,
  } = {}) {
    this.adapter = adapter;
    this.api = api;
    this.storage = storage;
    this.toast = toast;
    this.instanceManager = instanceManager;
    this.dirtyManager = dirtyManager;
    this.cubeBrowser = cubeBrowser;
    this.versionDialog = versionDialog;
    this.dialogs = dialogs || null;
    this.flavorService = flavorService || null;
    this.createPreviewRestorer = null;
    this.createPreviewCanvas = null;
  }

  async save({ cubeIds = null, button = null } = {}) {
    return this.saveImplementation({ cubeIds, button });
  }

  async startCreateCubeFromMarker(markerNode) {
    try {
      const candidate = this.analyzeCreateCandidateFromMarker(markerNode);
      this.startCreateCubePreview(candidate);
      const createDestinationContext = await this.loadCreateCubeDestinations();
      const values = await this.dialogs?.openCreateCube?.({
        candidate,
        destinations: createDestinationContext.destinations,
        deriveCubeId: (defaultAlias, destination, targetModel) =>
          this.deriveCreateCubeId(defaultAlias, destination, targetModel),
        onCreateDestination: () => this.createAuthoringPackFromModal(createDestinationContext),
      });
      if (!values) {
        return null;
      }
      const result = await this.saveCreatedCubeCandidate(candidate, values);
      this.pushToastMessage('success', 'SugarCube created', result.summary);
      return result;
    } catch (error) {
      const exportError =
        error instanceof SugarCubeExportError ? error : SugarCubeExportError.from(error);
      const detail = exportError.detail || this.formatViolations(exportError.violations);
      this.pushToastMessage('error', exportError.message, detail);
      this.adapter?.getConsole?.()?.error?.(exportError.message);
      return null;
    } finally {
      this.clearCreateCubePreview();
    }
  }

  analyzeCreateCandidateFromMarker(markerNode) {
    const appRef = this.adapter?.getApp?.();
    const graph = markerNode?.graph ?? appRef?.graph;
    if (!graph || !markerNode || !isCubeMarkerType(markerNode)) {
      throw new Error('Marker unavailable.');
    }
    const existingCubeId = readWidgetValue(markerNode, 'cube_id');
    if (typeof existingCubeId === 'string' && existingCubeId.trim()) {
      throw new Error('This SugarCube is already initialized.');
    }
    const defaultAlias = this.readMarkerDefaultAlias(markerNode);
    const candidate = this.collectCreateCandidateFromMarker(graph, markerNode, defaultAlias);
    if (!candidate.nodeIds.length) {
      throw new Error('No nodes connected to this marker.');
    }

    const targetModel = DEFAULT_TARGET_MODEL;
    const cubeId = this.deriveCreateCubeId(defaultAlias || 'SugarCube', undefined, targetModel);
    return {
      graph,
      markerNode,
      defaultAlias,
      targetModel,
      supportedModels: defaultSupportedModelsForTarget(targetModel),
      cubeId,
      filename: cubeId.split('/').pop() || 'cube.cube',
      markerIds: candidate.markerIds,
      nodeIds: candidate.nodeIds,
      markers: candidate.markers,
      nodes: candidate.nodes,
      warnings: candidate.warnings,
      description: '',
    };
  }

  deriveCreateCubeId(
    defaultAlias,
    destination = DEFAULT_LOCAL_CREATE_DESTINATION,
    targetModel = DEFAULT_TARGET_MODEL,
  ) {
    const target = destination || DEFAULT_LOCAL_CREATE_DESTINATION;
    const normalizedTargetModel = normalizeTargetModel(targetModel) || DEFAULT_TARGET_MODEL;
    const route = normalizeCubeRoute(defaultAlias);
    const routeSegments = route
      ? route.split('/')
      : [normalizedTargetModel, normalizeDefaultAliasTitle(defaultAlias) || 'SugarCube'];
    const targetCubePath =
      routeSegments.length > 1
        ? `${routeSegments.slice(0, -1).join('/')}/${suggestCanonicalCubePath(routeSegments.at(-1))}`
        : `${normalizedTargetModel}/${suggestCanonicalCubePath(routeSegments[0])}`;
    if (target?.sourceKind === 'github' && target.owner && target.repo) {
      return `${target.owner}/${target.repo}/${targetCubePath}`;
    }
    const namespace =
      target?.sourceKind === 'local' && target.namespace ? target.namespace : 'personal';
    return `local/${namespace}/${targetCubePath}`;
  }

  async loadCreateCubeDestinations() {
    const destinations = [{ ...DEFAULT_LOCAL_CREATE_DESTINATION }];
    let identityPolicy = null;
    if (!this.api?.listCubePacks) {
      destinations.push({ ...CREATE_PACK_DESTINATION_ACTION });
      return { destinations, identityPolicy };
    }
    try {
      const { response, data } = await this.api.listCubePacks();
      if (!response?.ok || data?.error) {
        throw new Error(
          data?.error?.message || response?.statusText || 'Failed to load cube packs',
        );
      }
      identityPolicy = data?.identity_policy || null;
      const repos = Array.isArray(data?.repos) ? data.repos : [];
      const seen = new Set(destinations.map((destination) => destination.key));
      for (const repo of repos) {
        const destination = this.normalizeCreateCubePackDestination(repo);
        if (!destination || seen.has(destination.key)) {
          continue;
        }
        destinations.push(destination);
        seen.add(destination.key);
      }
    } catch (error) {
      this.pushToastMessage(
        'warn',
        'Cube packs unavailable',
        error?.message || 'Only local saving is available right now.',
      );
    }
    destinations.push({ ...CREATE_PACK_DESTINATION_ACTION });
    return { destinations, identityPolicy };
  }

  normalizeCreateCubePackDestination(repo) {
    if (!repo?.enabled || !repo?.is_writable) {
      return null;
    }
    const owner = typeof repo.owner === 'string' ? repo.owner.trim() : '';
    const name = typeof repo.repo === 'string' ? repo.repo.trim() : '';
    if (!owner || !name) {
      return null;
    }
    return {
      key: `github/${owner}/${name}`,
      sourceKind: 'github',
      owner,
      repo: name,
      repoRef: `${owner}/${name}`,
      label: name,
      detail: owner,
      writable: true,
    };
  }

  async createAuthoringPackFromModal(context = {}) {
    const owner =
      typeof context?.identityPolicy?.claimed_github_owner === 'string'
        ? context.identityPolicy.claimed_github_owner.trim()
        : '';
    if (!owner) {
      throw new Error(
        'Set a claimed GitHub owner in SugarCubes authoring settings before creating a cube pack.',
      );
    }
    const values = await this.dialogs?.openForm?.({
      title: 'Create Cube Pack',
      message: ['Create a writable cube pack and save this SugarCube there.'],
      confirmLabel: 'Create Pack',
      fields: [
        {
          key: 'repo',
          label: 'Pack name',
          placeholder: 'My-Cubes',
          required: true,
          normalizeValue: (value) => value.trim(),
        },
      ],
    });
    if (!values) {
      return null;
    }
    if (!this.api?.createAuthoringCubePack) {
      throw new Error('Cube pack creation is unavailable.');
    }
    const { response, data } = await this.api.createAuthoringCubePack(
      JSON.stringify({
        owner,
        repo: values.repo,
        enabled: true,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    if (!response.ok || data?.error) {
      throw new Error(data?.error?.message || response.statusText || 'Failed to create cube pack');
    }
    const destination = this.normalizeCreateCubePackDestination(data?.repo);
    if (!destination) {
      throw new Error('Created cube pack is not writable.');
    }
    this.pushToastMessage('success', 'Cube Pack created', `${destination.repoRef} is ready.`);
    context.destinations = Array.isArray(context.destinations) ? context.destinations : [];
    const actionIndex = context.destinations.findIndex((entry) => entry?.action === 'create-pack');
    const existingIndex = context.destinations.findIndex((entry) => entry?.key === destination.key);
    if (existingIndex < 0) {
      const insertIndex = actionIndex >= 0 ? actionIndex : context.destinations.length;
      context.destinations.splice(insertIndex, 0, destination);
    }
    return destination;
  }

  readMarkerDefaultAlias(markerNode) {
    const value = readWidgetValue(markerNode, 'default_alias');
    return normalizeDefaultAliasTitle(value);
  }

  collectCreateCandidateFromMarker(graph, markerNode, defaultAliasKey) {
    if (!CREATE_CANDIDATE_MARKER_TYPES.has(markerNode?.type)) {
      throw new Error('Create cube starts from a cube input or output marker.');
    }
    const allNodes = getGraphNodes(graph);
    const nodesById = new Map();
    for (const node of allNodes) {
      if (node?.id == null) {
        continue;
      }
      nodesById.set(String(node.id), node);
    }
    const { outgoing, incoming } = buildLinkIndex(graph);
    const visited = new Set();
    const queue = [];
    const startId = String(markerNode.id);
    const markerIdSet = new Set([startId]);
    const executableIdSet = new Set();
    const direction = markerNode.type === 'SugarCubes.CubeOutput' ? 'incoming' : 'outgoing';

    const shouldIncludeMarker = (node) =>
      CREATE_CANDIDATE_MARKER_TYPES.has(node?.type) &&
      this.readMarkerDefaultAlias(node) === defaultAliasKey;

    const enqueueNode = (nodeId) => {
      if (nodeId == null) {
        return;
      }
      const nodeKey = String(nodeId);
      if (visited.has(nodeKey)) {
        return;
      }
      visited.add(nodeKey);
      const node = nodesById.get(nodeKey);
      if (!node) {
        return;
      }
      if (isCubeMarkerType(node)) {
        if (nodeKey === startId || shouldIncludeMarker(node)) {
          markerIdSet.add(nodeKey);
        }
        return;
      }
      executableIdSet.add(nodeKey);
      queue.push(nodeKey);
    };

    visited.add(startId);
    const seedEdges = direction === 'outgoing' ? outgoing.get(startId) : incoming.get(startId);
    for (const edge of seedEdges ?? []) {
      enqueueNode(
        direction === 'outgoing'
          ? (edge.target_id ?? edge.target)
          : (edge.origin_id ?? edge.origin),
      );
    }

    while (queue.length) {
      const current = queue.shift();
      const edges = direction === 'outgoing' ? outgoing.get(current) : incoming.get(current);
      for (const edge of edges ?? []) {
        enqueueNode(
          direction === 'outgoing'
            ? (edge.target_id ?? edge.target)
            : (edge.origin_id ?? edge.origin),
        );
      }
    }

    const markers = [];
    const nodes = [];
    const markerIds = [];
    const nodeIds = [];
    for (const node of allNodes) {
      const key = String(node?.id);
      if (markerIdSet.has(key)) {
        markers.push(node);
        markerIds.push(node.id);
      } else if (executableIdSet.has(key)) {
        nodes.push(node);
        nodeIds.push(node.id);
      }
    }
    return { markerIds, nodeIds, markers, nodes, warnings: [] };
  }

  startCreateCubePreview(candidate) {
    this.clearCreateCubePreview();
    const entries = [...(candidate?.nodes || []), ...(candidate?.markers || [])].filter(Boolean);
    if (!entries.length) {
      return;
    }
    const bounds = this.computePreviewBounds(candidate);
    const canvas = this.resolveCreatePreviewCanvas();
    const previousBackground = canvas?.onDrawBackground || null;
    const service = this;
    let previewBackground = null;
    if (canvas) {
      previewBackground = function sugarCubesCreatePreviewBackground(ctx) {
        previousBackground?.apply(this, arguments);
        service.drawCreatePreviewGroup(ctx, this, candidate, bounds);
      };
      canvas.onDrawBackground = previewBackground;
      this.createPreviewCanvas = canvas;
    }
    candidate?.graph?.setDirtyCanvas?.(true, true);
    canvas?.setDirty?.(true, true);
    this.createPreviewRestorer = () => {
      if (canvas?.onDrawBackground === previewBackground) {
        canvas.onDrawBackground = previousBackground;
      }
      candidate?.graph?.setDirtyCanvas?.(true, true);
      canvas?.setDirty?.(true, true);
    };
  }

  resolveCreatePreviewCanvas() {
    const appRef = this.adapter?.getApp?.() || this.adapter?.getWindow?.()?.app || null;
    const windowRef =
      this.adapter?.getWindow?.() || (typeof window !== 'undefined' ? window : null);
    return (
      appRef?.canvas ||
      appRef?.graph?.canvas ||
      this.adapter?.getCanvas?.() ||
      windowRef?.LGraphCanvas?.active_canvas ||
      null
    );
  }

  computePreviewBounds(candidate) {
    return resolveNewInstanceBounds({
      nodes: candidate?.nodes || [],
      markers: candidate?.markers || [],
    });
  }

  drawCreatePreviewGroup(ctx, graphCanvas, candidate, bounds) {
    if (!ctx || !bounds) {
      return;
    }
    const title = `${candidate?.defaultAlias || 'SugarCube'} Preview`;
    const fontSize = 24;
    const alpha = Number(graphCanvas?.editor_alpha) || 1;
    ctx.save();
    ctx.globalAlpha = 0.25 * alpha;
    ctx.fillStyle = '#f7c948';
    ctx.strokeStyle = '#f7c948';
    ctx.beginPath();
    ctx.rect(bounds.x + 0.5, bounds.y + 0.5, bounds.w, fontSize * 1.4);
    ctx.fill();
    ctx.beginPath();
    ctx.rect(bounds.x + 0.5, bounds.y + 0.5, bounds.w, bounds.h);
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.stroke();
    ctx.font = `${fontSize}px Arial`;
    ctx.textAlign = 'left';
    ctx.fillText(title, bounds.x + 4, bounds.y + fontSize);
    ctx.restore();
  }

  clearCreateCubePreview() {
    const restore = this.createPreviewRestorer;
    this.createPreviewRestorer = null;
    this.createPreviewCanvas = null;
    restore?.();
  }

  async saveCreatedCubeCandidate(candidate, values) {
    const profile = await this.ensureAuthorProfile();
    if (!profile) {
      throw new Error('Add an author profile before saving.');
    }
    const graph = candidate?.graph;
    if (!graph) {
      throw new Error('Unable to access the current graph');
    }
    const targetModel = normalizeTargetModel(values?.targetModel) || DEFAULT_TARGET_MODEL;
    const requestedAlias = normalizeCubeRoute(values?.defaultAlias || '');
    const shortName = normalizeDefaultAliasTitle(
      values?.cubeName || values?.name || values?.defaultAlias,
    );
    const defaultAlias =
      requestedAlias && requestedAlias.includes('/')
        ? requestedAlias
        : `${targetModel}/${shortName || 'SugarCube'}`;
    const cubeId = typeof values?.cubeId === 'string' ? values.cubeId.trim() : '';
    const supportedModels = normalizeSupportedModels(values?.supportedModels, {
      targetModel,
    });
    if (!defaultAlias || !isCanonicalCubeId(cubeId)) {
      throw new Error('A valid default alias and canonical cube id are required.');
    }
    const markerState = this.captureMarkerWidgetState(candidate.markers);
    try {
      updateMarkersForIds(graph, candidate.markerIds, {
        cubeId,
        defaultAlias,
        instanceAlias: defaultAlias,
      });
      this.instanceManager?.refresh?.({ graph, reason: 'cube-create' });
      const appRef = this.adapter?.getApp?.();
      const promptResult = appRef?.graphToPrompt?.();
      const resolved =
        promptResult && typeof promptResult.then === 'function' ? await promptResult : promptResult;
      const graphPayload = resolved?.output ?? resolved?.prompt ?? resolved;
      if (!graphPayload || typeof graphPayload !== 'object') {
        throw new Error('Unable to serialize the current graph');
      }
      const workflowPayload = resolved?.workflow ?? null;
      const workflowSupported =
        workflowPayload && typeof workflowPayload === 'object' && !Array.isArray(workflowPayload);
      if (!workflowSupported) {
        throw new Error('Workflow payload unavailable');
      }
      const enrichedWorkflowPayload = this.enrichWorkflowPayload(workflowPayload, graph);
      const requestBody = {
        graph: graphPayload,
        actor: { author: profile.author, author_url: profile.author_url || '' },
        cubes: [
          {
            cube_id: cubeId,
            forked: false,
            lineage: null,
            previous_cube_id: '',
            description: typeof values?.description === 'string' ? values.description : '',
            metadata: {
              default_alias: defaultAlias,
              target_model: targetModel,
              supported_models: supportedModels,
            },
          },
        ],
        workflow: enrichedWorkflowPayload,
        workflow_version: enrichedWorkflowPayload?.version ?? null,
      };
      const { response, data } = await this.api.saveImplementation(JSON.stringify(requestBody), {
        headers: { 'Content-Type': 'application/json' },
      });
      const errorPayload = data?.error;
      if (!response.ok || errorPayload) {
        const message = errorPayload?.message ?? response.statusText ?? 'Export failed';
        const detail = this.buildErrorDetail(errorPayload);
        throw new SugarCubeExportError(message, detail, errorPayload?.violations);
      }
      const saved = Array.isArray(data?.saved) ? data.saved : [];
      const summary = saved.length
        ? saved.map((entry) => this.formatSaveSummaryEntry(entry)).join('\n')
        : `saved only: ${defaultAlias} -> ${candidate.filename}`;
      const savedIds = saved
        .map((entry) => (typeof entry?.cube_id === 'string' ? entry.cube_id : ''))
        .filter(Boolean);
      const cleanIds = savedIds.length ? savedIds : [cubeId];
      this.dirtyManager?.addSavedIds?.(cleanIds);
      this.dirtyManager?.markClean?.({ graph, cubeIds: cleanIds });
      this.instanceManager?.scheduleRefresh?.({ graph, reason: 'cube-create' });
      this.dirtyManager?.scheduleRefresh?.({ graph, reason: 'cube-create' });
      this.cubeBrowser?.refresh?.({ force: true }).catch((_error) => {});
      return { cubeId, defaultAlias, targetModel, supportedModels, summary, saved };
    } catch (error) {
      this.restoreMarkerWidgetState(markerState);
      this.instanceManager?.refresh?.({ graph, reason: 'cube-create-rollback' });
      throw error;
    }
  }

  captureMarkerWidgetState(markers) {
    return (Array.isArray(markers) ? markers : []).map((marker) => ({
      marker,
      values: {
        cube_id: readWidgetValue(marker, 'cube_id'),
        default_alias: readWidgetValue(marker, 'default_alias'),
        instance_alias: readWidgetValue(marker, 'instance_alias'),
        instance_id: readWidgetValue(marker, 'instance_id'),
      },
    }));
  }

  restoreMarkerWidgetState(entries) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      for (const [name, value] of Object.entries(entry.values || {})) {
        writeWidgetValue(entry.marker, name, value);
      }
    }
  }

  async saveImplementation({ cubeIds = null, button = null } = {}) {
    const setBusy =
      typeof button?.enabled === 'boolean'
        ? (busy) => {
            button.enabled = !busy;
            button.element?.classList?.toggle('sugarcubes-save--busy', Boolean(busy));
          }
        : (_busy) => {};

    setBusy(true);
    try {
      const profile = await this.ensureAuthorProfile();
      if (!profile) {
        this.pushToastMessage('warn', 'Author required', 'Add an author profile before saving.');
        return;
      }

      const appRef = this.adapter?.getApp?.();
      const graph = appRef?.graph;
      if (!graph) {
        throw new Error('Unable to access the current graph');
      }

      const { assigned, replacements } = await this.ensureCubeIds(graph);
      const assignedIds = assigned.map((entry) => entry.cubeId);
      const targetCubeIds = this.resolveCubeIds(cubeIds);
      const replacementIds = Array.from(replacements.values());
      const cubeEntries = Array.isArray(this.cubeBrowser?.getCubes?.())
        ? this.cubeBrowser.getCubes()
        : [];
      const cubeIndex = this.buildCubeEntryIndex(cubeEntries);
      const sourceMetadataIndex = this.buildInstanceSaveMetadataIndex(graph);
      const usedNames = new Set(
        cubeEntries
          .map((entry) => (typeof entry?.name === 'string' ? entry.name : ''))
          .filter(Boolean),
      );

      const savePlan = [];
      const previousIdByCubeId = new Map();
      for (const [previousCubeId, nextCubeId] of replacements.entries()) {
        if (typeof previousCubeId === 'string' && previousCubeId.trim() && nextCubeId) {
          previousIdByCubeId.set(nextCubeId, previousCubeId.trim());
        }
      }
      const finalCubeIds = Array.from(
        new Set([
          ...targetCubeIds.filter(
            (cubeId) => isCanonicalCubeId(cubeId) && !replacements.has(cubeId),
          ),
          ...assignedIds,
          ...replacementIds,
        ]),
      );
      if (!finalCubeIds.length) {
        this.pushToastMessage('info', 'No changes', 'No dirty SugarCubes to save.');
        return;
      }
      for (const cubeId of finalCubeIds) {
        const entry = cubeIndex.get(cubeId);
        const sourceMetadata = this.resolveSavePlanSourceMetadata(cubeId, sourceMetadataIndex);
        const entryMetadata = this.buildSaveEntryMetadata({
          cubeId,
          browserEntry: entry,
          sourceMetadata,
        });
        if (!entry) {
          savePlan.push({
            cubeId,
            forked: false,
            lineage: null,
            metadata: entryMetadata,
            previousCubeId: previousIdByCubeId.get(cubeId) || '',
            latestVersion: '',
            ...sourceMetadata,
          });
          continue;
        }
        if (this.isWritableEntry(entry)) {
          savePlan.push({
            cubeId,
            forked: false,
            lineage: null,
            metadata: entryMetadata,
            previousCubeId: previousIdByCubeId.get(cubeId) || '',
            latestVersion: normalizeCubeVersion(entry.version),
            ...sourceMetadata,
          });
          continue;
        }
        const forkedName = this.buildForkedName(entry.name || 'SugarCube', usedNames);
        usedNames.add(forkedName);
        const forkedTargetModel =
          normalizeTargetModel(entry.target_model) ||
          this.deriveTargetModelFromCubeIdSafe(entry.cube_id) ||
          DEFAULT_TARGET_MODEL;
        const forkedId = await this.promptForCanonicalCubeId({
          defaultAlias: forkedName,
          targetModel: forkedTargetModel,
          promptLabel: entry?.write_block_reason
            ? `${entry.write_block_reason} Fork this cube as (owner/repo/Target Model/Cube Name.cube or local/namespace/Target Model/Cube Name.cube).`
            : 'Fork cube as (owner/repo/Target Model/Cube Name.cube or local/namespace/Target Model/Cube Name.cube)',
        });
        if (!forkedId) {
          throw new Error(`Canonical cube id is required to fork '${entry.name || cubeId}'.`);
        }
        const updatedMarkers = updateMarkersForCubeId(graph, cubeId, {
          cubeId: forkedId,
          defaultAlias: forkedName,
        });
        if (!updatedMarkers) {
          throw new Error(`Unable to fork cube '${entry.name || cubeId}' (markers missing).`);
        }
        savePlan.push({
          cubeId: forkedId,
          forked: true,
          lineage: this.buildLineagePayload(entry),
          metadata: this.buildSaveEntryMetadata({
            cubeId: forkedId,
            browserEntry: {
              ...entry,
              target_model: forkedTargetModel,
            },
          }),
          previousCubeId: cubeId,
          staleRevision: false,
          sourceEntries: [],
          sourceRevisionRef: '',
          sourceVersion: '',
          sourceDefinitionKey: '',
          staleSaveMode: '',
          latestVersion: normalizeCubeVersion(entry.version),
        });
      }

      const historicalChoice = await this.resolveHistoricalSaveChoice(savePlan);
      if (historicalChoice === null) {
        return;
      }
      if (historicalChoice === 'fork') {
        await this.forkStaleSaveEntries({ graph, savePlan, cubeIndex, usedNames });
      } else if (historicalChoice === STALE_SAVE_MODE_LATEST) {
        for (const entry of savePlan) {
          if (entry.staleRevision) {
            entry.staleSaveMode = STALE_SAVE_MODE_LATEST;
          }
        }
      }

      if (savePlan.some((entry) => entry.forked)) {
        this.instanceManager?.scheduleRefresh?.({ graph, reason: 'fork' });
        this.dirtyManager?.scheduleRefresh?.({ graph, reason: 'fork' });
      }

      const promptResult = appRef?.graphToPrompt?.();
      const resolved =
        promptResult && typeof promptResult.then === 'function' ? await promptResult : promptResult;
      const graphPayload = resolved?.output ?? resolved?.prompt ?? resolved;
      if (!graphPayload || typeof graphPayload !== 'object') {
        throw new Error('Unable to serialize the current graph');
      }

      const workflowPayload = resolved?.workflow ?? null;
      const workflowSupported =
        workflowPayload && typeof workflowPayload === 'object' && !Array.isArray(workflowPayload);
      if (!workflowSupported) {
        throw new Error('Workflow payload unavailable');
      }
      const enrichedWorkflowPayload = this.enrichWorkflowPayload(workflowPayload, graph);
      const requestBody = {
        graph: graphPayload,
        actor: { author: profile.author, author_url: profile.author_url || '' },
        cubes: savePlan.map((entry) => ({
          cube_id: entry.cubeId,
          forked: entry.forked,
          lineage: entry.lineage,
          previous_cube_id: entry.previousCubeId,
          source_revision_ref: entry.sourceRevisionRef || '',
          source_version: entry.sourceVersion || '',
          source_definition_key: entry.sourceDefinitionKey || '',
          stale_save_mode: entry.staleSaveMode || '',
          ...(entry.metadata ? { metadata: entry.metadata } : {}),
        })),
        workflow: enrichedWorkflowPayload,
        workflow_version: enrichedWorkflowPayload?.version ?? null,
      };

      const { response, data } = await this.api.saveImplementation(JSON.stringify(requestBody), {
        headers: { 'Content-Type': 'application/json' },
      });
      const errorPayload = data?.error;
      if (!response.ok || errorPayload) {
        const message = errorPayload?.message ?? response.statusText ?? 'Export failed';
        const detail = this.buildErrorDetail(errorPayload);
        throw new SugarCubeExportError(message, detail, errorPayload?.violations);
      }

      const saved = Array.isArray(data?.saved) ? data.saved : [];
      const summary = saved.length
        ? saved.map((entry) => this.formatSaveSummaryEntry(entry)).join('\n')
        : 'No cubes were saved';
      this.pushToastMessage('success', 'SugarCubes exported', summary);
      this.cubeBrowser?.refresh?.({ force: true }).catch((_error) => {});

      const warnings = Array.isArray(data?.warnings) ? data.warnings.filter(Boolean) : [];
      if (warnings.length) {
        this.pushToastMessage('warn', 'SugarCubes warnings', warnings.join('\n'));
      }

      const versionSuggestions = Array.isArray(data?.version_suggestions)
        ? data.version_suggestions
        : [];
      if (versionSuggestions.length) {
        await this.versionDialog?.open?.(versionSuggestions);
      }

      const savedIds = saved
        .map((entry) => (typeof entry?.cube_id === 'string' ? entry.cube_id : ''))
        .filter(Boolean);
      if (savedIds.length) {
        const metadataChanged = this.applySavedVersionMetadata({ graph, savePlan, saved });
        if (metadataChanged) {
          this.instanceManager?.scheduleRefresh?.({
            graph,
            reason: 'save-version-metadata',
          });
        }
        this.dirtyManager?.addSavedIds?.(savedIds);
        this.dirtyManager?.markClean?.({ graph, cubeIds: savedIds });
        this.dirtyManager?.scheduleRefresh?.({ graph, reason: 'save' });
      }
    } catch (error) {
      const exportError =
        error instanceof SugarCubeExportError ? error : SugarCubeExportError.from(error);
      const detail = exportError.detail || this.formatViolations(exportError.violations);
      this.pushToastMessage('error', exportError.message, detail);
      this.adapter?.getConsole?.()?.error?.(exportError.message);
    } finally {
      setBusy(false);
    }
  }

  async saveCurrentFaceValuesAsDefault(metadata) {
    return this.flavorService?.saveCurrentFaceValuesAsDefault?.(metadata);
  }

  async saveCurrentFaceValuesAsCubeDefaults(metadata) {
    return this.flavorService?.saveCurrentFaceValuesAsCubeDefaults?.(metadata);
  }

  async saveCurrentFaceValuesAsAuthoredFlavor(metadata) {
    return this.flavorService?.saveCurrentFaceValuesAsAuthoredFlavor?.(metadata);
  }

  async saveCurrentFaceValuesAsLocalFlavor(metadata) {
    return this.flavorService?.saveCurrentFaceValuesAsLocalFlavor?.(metadata);
  }

  async manageFlavors(metadata) {
    return this.flavorService?.manageFlavors?.(metadata);
  }

  buildInstanceSaveMetadataIndex(graph) {
    const byCubeId = new Map();
    const addEntry = (entry) => {
      const cubeId = typeof entry?.cubeId === 'string' ? entry.cubeId.trim() : '';
      if (!cubeId) {
        return;
      }
      const list = byCubeId.get(cubeId) || [];
      const dedupeKey = `${entry.instanceId || ''}|${entry.sourceDefinitionKey || ''}|${entry.markerIds?.join(',') || ''}`;
      if (
        dedupeKey.trim() &&
        list.some(
          (existing) =>
            `${existing.instanceId || ''}|${existing.sourceDefinitionKey || ''}|${existing.markerIds?.join(',') || ''}` ===
            dedupeKey,
        )
      ) {
        return;
      }
      list.push(entry);
      byCubeId.set(cubeId, list);
    };

    for (const group of getGraphGroups(graph)) {
      const metadata = getGroupSugarcubes(group);
      if (!metadata?.managed) {
        continue;
      }
      const cubeId = typeof metadata.cube_id === 'string' ? metadata.cube_id.trim() : '';
      if (!cubeId) {
        continue;
      }
      const sourceVersion = normalizeCubeVersion(metadata.cube_version);
      const sourceRevisionRef = normalizeRevisionRef(metadata.cube_revision_ref);
      const sourceDefinitionKey =
        typeof metadata.cube_definition_key === 'string' && metadata.cube_definition_key.trim()
          ? metadata.cube_definition_key.trim()
          : buildCubeDefinitionKey(cubeId, sourceVersion);
      addEntry({
        cubeId,
        defaultAlias:
          typeof metadata.default_alias === 'string' && metadata.default_alias.trim()
            ? metadata.default_alias.trim()
            : cubeId,
        sourceVersion,
        sourceRevisionRef,
        sourceDefinitionKey,
        staleRevision: !isCurrentRevisionRef(sourceRevisionRef),
        targetModel:
          typeof metadata.target_model === 'string' && metadata.target_model.trim()
            ? metadata.target_model.trim()
            : '',
        supportedModels: Array.isArray(metadata.supported_models)
          ? metadata.supported_models.filter((value) => typeof value === 'string')
          : [],
        markerIds: this.extractMetadataMarkerIds(metadata),
        group,
        instanceId:
          typeof metadata.instance_id === 'string' && metadata.instance_id.trim()
            ? metadata.instance_id.trim()
            : '',
      });
    }

    const builder =
      this.instanceManager?.instanceBuilder ||
      new InstanceBuilder({ logger: this.adapter?.getConsole?.() });
    for (const instance of builder.build(graph)) {
      if (!instance?.cubeId) {
        continue;
      }
      const sourceRevisionRef = normalizeRevisionRef(instance.cubeRevisionRef);
      const sourceVersion = normalizeCubeVersion(instance.cubeVersion);
      addEntry({
        cubeId: instance.cubeId,
        defaultAlias: instance.defaultAlias || instance.cubeId,
        sourceVersion,
        sourceRevisionRef,
        sourceDefinitionKey:
          instance.cubeDefinitionKey || buildCubeDefinitionKey(instance.cubeId, sourceVersion),
        staleRevision: !isCurrentRevisionRef(sourceRevisionRef),
        targetModel: instance.targetModel || '',
        supportedModels: Array.isArray(instance.supportedModels) ? instance.supportedModels : [],
        markerIds: Array.isArray(instance.markerIds) ? instance.markerIds : [],
        group: null,
        instanceId: instance.instanceId || '',
      });
    }
    return byCubeId;
  }

  extractMetadataMarkerIds(metadata) {
    const rawMarkers = metadata?.markers;
    if (Array.isArray(rawMarkers)) {
      return rawMarkers.filter((value) => value != null);
    }
    if (!rawMarkers || typeof rawMarkers !== 'object') {
      return [];
    }
    return Object.values(rawMarkers).flatMap((value) =>
      Array.isArray(value) ? value.filter((entry) => entry != null) : [],
    );
  }

  resolveSavePlanSourceMetadata(cubeId, sourceMetadataIndex) {
    const entries = Array.isArray(sourceMetadataIndex?.get?.(cubeId))
      ? sourceMetadataIndex.get(cubeId)
      : [];
    const staleEntries = entries.filter((entry) => entry.staleRevision);
    const selected = staleEntries[0] || entries[0] || null;
    return {
      sourceEntries: entries,
      sourceRevisionRef: selected?.sourceRevisionRef || '',
      sourceVersion: selected?.sourceVersion || '',
      sourceDefinitionKey: selected?.sourceDefinitionKey || '',
      staleRevision: Boolean(staleEntries.length),
      staleSaveMode: '',
      selectedSourceEntry: selected,
      defaultAlias: selected?.defaultAlias || '',
      targetModel: selected?.targetModel || '',
      supportedModels: selected?.supportedModels || [],
    };
  }

  buildSaveEntryMetadata({ cubeId, browserEntry = null, sourceMetadata = null } = {}) {
    let defaultAlias = '';
    try {
      defaultAlias = deriveRouteFromCubeId(cubeId);
    } catch (_error) {
      defaultAlias = '';
    }
    const targetModel =
      normalizeTargetModel(browserEntry?.target_model) ||
      normalizeTargetModel(sourceMetadata?.targetModel) ||
      this.deriveTargetModelFromCubeIdSafe(cubeId);
    if (!defaultAlias && !targetModel) {
      return null;
    }
    const supportedSource = Array.isArray(browserEntry?.supported_models)
      ? browserEntry.supported_models
      : Array.isArray(sourceMetadata?.supportedModels)
        ? sourceMetadata.supportedModels
        : defaultSupportedModelsForTarget(targetModel);
    return {
      ...(defaultAlias ? { default_alias: defaultAlias } : {}),
      target_model: targetModel,
      supported_models: normalizeSupportedModels(supportedSource, { targetModel }),
    };
  }

  deriveTargetModelFromCubeIdSafe(cubeId) {
    try {
      return normalizeTargetModel(deriveTargetModelFromCubeId(cubeId));
    } catch (_error) {
      return '';
    }
  }

  async resolveHistoricalSaveChoice(savePlan) {
    const staleEntries = savePlan.filter((entry) => entry.staleRevision);
    if (!staleEntries.length) {
      return '';
    }
    const choice = await this.dialogs?.chooseHistoricalVersionSaveAction?.({
      entries: staleEntries.map((entry) => ({
        cubeId: entry.cubeId,
        defaultAlias: entry.defaultAlias || entry.cubeId,
        sourceVersion: entry.sourceVersion,
        sourceRevisionRef: entry.sourceRevisionRef,
      })),
    });
    if (choice === STALE_SAVE_MODE_LATEST || choice === 'fork') {
      return choice;
    }
    return null;
  }

  async forkStaleSaveEntries({ graph, savePlan, cubeIndex, usedNames }) {
    for (const entry of savePlan) {
      if (!entry.staleRevision) {
        continue;
      }
      const sourceEntries = Array.isArray(entry.sourceEntries)
        ? entry.sourceEntries.filter((source) => source.staleRevision)
        : [];
      const markerIds = Array.from(
        new Set(sourceEntries.flatMap((source) => source.markerIds || []).filter(Boolean)),
      );
      if (!markerIds.length) {
        throw new Error(
          `Unable to fork '${entry.defaultAlias || entry.cubeId}' (markers missing).`,
        );
      }
      const browserEntry = cubeIndex.get(entry.cubeId) || {};
      const forkedName = this.buildForkedName(
        entry.defaultAlias || browserEntry.name || 'SugarCube',
        usedNames,
      );
      usedNames.add(forkedName);
      const forkedId = await this.promptForCanonicalCubeId({
        defaultAlias: forkedName,
        targetModel:
          normalizeTargetModel(browserEntry.target_model) ||
          this.deriveTargetModelFromCubeIdSafe(entry.cubeId) ||
          DEFAULT_TARGET_MODEL,
        promptLabel:
          'Fork this older version as (owner/repo/Target Model/Cube Name.cube or local/namespace/Target Model/Cube Name.cube).',
      });
      if (!forkedId) {
        throw new Error(`Canonical cube id is required to fork '${forkedName}'.`);
      }
      const updatedMarkers = updateMarkersForIds(graph, markerIds, {
        cubeId: forkedId,
        defaultAlias: forkedName,
        cubeVersion: '',
        cubeRevisionRef: CURRENT_REVISION_REF,
      });
      if (!updatedMarkers) {
        throw new Error(`Unable to fork '${forkedName}' (markers missing).`);
      }
      for (const source of sourceEntries) {
        this.updateSourceGroupIdentity(source, {
          cubeId: forkedId,
          defaultAlias: forkedName,
          cubeVersion: '',
          cubeRevisionRef: CURRENT_REVISION_REF,
        });
      }
      entry.previousCubeId = entry.cubeId;
      entry.cubeId = forkedId;
      entry.forked = true;
      entry.lineage = this.buildHistoricalLineagePayload(browserEntry, entry);
      entry.metadata = this.buildSaveEntryMetadata({
        cubeId: forkedId,
        browserEntry,
      });
      entry.staleRevision = false;
      entry.sourceEntries = [];
      entry.sourceRevisionRef = '';
      entry.sourceVersion = '';
      entry.sourceDefinitionKey = '';
      entry.staleSaveMode = '';
      entry.latestVersion = '';
      entry.defaultAlias = forkedName;
    }
  }

  updateSourceGroupIdentity(source, { cubeId, defaultAlias, cubeVersion, cubeRevisionRef }) {
    const group = source?.group;
    const metadata = getGroupSugarcubes(group);
    if (!metadata) {
      return;
    }
    const nextVersion = normalizeCubeVersion(cubeVersion);
    setGroupSugarcubes(group, {
      ...metadata,
      cube_id: cubeId,
      default_alias: defaultAlias || metadata.default_alias || cubeId,
      cube_version: nextVersion,
      cube_revision_ref: normalizeRevisionRef(cubeRevisionRef),
      cube_definition_key: buildCubeDefinitionKey(cubeId, nextVersion),
    });
  }

  applySavedVersionMetadata({ graph, savePlan, saved }) {
    const versionByCubeId = new Map(
      (Array.isArray(saved) ? saved : [])
        .map((entry) => [
          typeof entry?.cube_id === 'string' ? entry.cube_id.trim() : '',
          this.resolveSavedEntryVersion(entry),
        ])
        .filter(([cubeId, version]) => cubeId && version),
    );
    let changed = false;
    for (const entry of savePlan) {
      const savedVersion =
        versionByCubeId.get(entry.cubeId) || normalizeCubeVersion(entry.latestVersion);
      if (!savedVersion) {
        continue;
      }
      const sourceEntries = this.resolveSavedVersionSourceEntries(entry);
      if (!sourceEntries.length) {
        continue;
      }
      if (
        this.applySavedVersionToSourceEntries({
          graph,
          entry,
          sourceEntries,
          savedVersion,
        })
      ) {
        changed = true;
      }
    }
    return changed;
  }

  resolveSavedVersionSourceEntries(entry) {
    if (entry?.staleSaveMode === STALE_SAVE_MODE_LATEST) {
      return Array.isArray(entry.sourceEntries)
        ? entry.sourceEntries.filter((source) => source.staleRevision)
        : [];
    }
    if (entry?.forked) {
      return [];
    }
    const selected = entry?.selectedSourceEntry;
    if (!selected || selected.staleRevision) {
      return [];
    }
    return [selected];
  }

  applySavedVersionToSourceEntries({ graph, entry, sourceEntries, savedVersion }) {
    const eligibleSources = Array.isArray(sourceEntries) ? sourceEntries.filter(Boolean) : [];
    const sourcesNeedingUpdate = eligibleSources.filter(
      (source) =>
        source.staleRevision ||
        normalizeCubeVersion(source.sourceVersion) !== savedVersion ||
        !isCurrentRevisionRef(source.sourceRevisionRef),
    );
    if (!sourcesNeedingUpdate.length) {
      return false;
    }
    const markerIds = Array.from(
      new Set(sourcesNeedingUpdate.flatMap((source) => source.markerIds || []).filter(Boolean)),
    );
    let changed = false;
    if (markerIds.length) {
      changed =
        updateMarkersForIds(graph, markerIds, {
          cubeVersion: savedVersion,
          cubeRevisionRef: CURRENT_REVISION_REF,
        }) > 0 || changed;
    }
    for (const source of sourcesNeedingUpdate) {
      if (!source?.group) {
        continue;
      }
      this.updateSourceGroupIdentity(source, {
        cubeId: entry.cubeId,
        defaultAlias: entry.defaultAlias || source.defaultAlias || entry.cubeId,
        cubeVersion: savedVersion,
        cubeRevisionRef: CURRENT_REVISION_REF,
      });
      changed = true;
    }
    return changed;
  }

  resolveSavedEntryVersion(entry) {
    const directVersion = normalizeCubeVersion(entry?.version);
    if (directVersion) {
      return directVersion;
    }
    const message = typeof entry?.commit_message === 'string' ? entry.commit_message : '';
    const match = message.match(/\bv([0-9]+(?:\.[0-9]+){2}(?:[-+][0-9A-Za-z.-]+)?)\b/);
    return normalizeCubeVersion(match?.[1]);
  }

  resolveCubeIds(cubeIds) {
    if (Array.isArray(cubeIds) && cubeIds.length) {
      return cubeIds.filter(Boolean);
    }
    const implementationDirty =
      typeof this.dirtyManager?.getImplementationDirtyCubeIds === 'function'
        ? Array.from(this.dirtyManager.getImplementationDirtyCubeIds() || [])
        : Array.from(this.dirtyManager?.getDirtyCubeIds?.() || []);
    if (implementationDirty.length) {
      return implementationDirty;
    }
    const dirty = Array.from(this.dirtyManager?.getDirtyCubeIds?.() || []);
    if (dirty.length) {
      return dirty;
    }
    return [];
  }

  enrichWorkflowPayload(workflowPayload, graph) {
    const cloned =
      workflowPayload && typeof workflowPayload === 'object'
        ? JSON.parse(JSON.stringify(workflowPayload))
        : {};
    const definitions =
      cloned.definitions && typeof cloned.definitions === 'object' ? { ...cloned.definitions } : {};
    definitions.subgraphs = this.collectWorkflowSubgraphs(workflowPayload, graph);
    cloned.definitions = definitions;
    return cloned;
  }

  collectWorkflowSubgraphs(workflowPayload, graph) {
    const merged = new Map();
    const declared = workflowPayload?.definitions?.subgraphs;
    if (Array.isArray(declared)) {
      for (const entry of declared) {
        const normalized = this.normalizeSubgraphEntry(entry, entry?.id);
        if (!normalized) {
          continue;
        }
        merged.set(normalized.id, normalized);
      }
    }

    const liveSubgraphs = graph?._subgraphs instanceof Map ? graph._subgraphs : null;
    if (liveSubgraphs) {
      for (const [subgraphId, subgraph] of liveSubgraphs.entries()) {
        const normalized = this.normalizeSubgraphEntry(subgraph, subgraphId);
        if (!normalized) {
          continue;
        }
        merged.set(normalized.id, normalized);
      }
    }

    return Array.from(merged.values());
  }

  normalizeSubgraphEntry(rawEntry, fallbackId) {
    if (!rawEntry) {
      return null;
    }
    let entry = rawEntry;
    if (typeof rawEntry?.asSerialisable === 'function') {
      try {
        entry = rawEntry.asSerialisable();
      } catch (_error) {
        return null;
      }
    } else if (typeof rawEntry?.serialize === 'function') {
      try {
        entry = rawEntry.serialize();
      } catch (_error) {
        return null;
      }
    } else if (rawEntry?.graph && typeof rawEntry.graph.asSerialisable === 'function') {
      try {
        entry = rawEntry.graph.asSerialisable();
      } catch (_error) {
        return null;
      }
    } else if (rawEntry?.graph && typeof rawEntry.graph.serialize === 'function') {
      try {
        entry = rawEntry.graph.serialize();
      } catch (_error) {
        return null;
      }
    }

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return null;
    }

    return normalizeSubgraphPayload(entry, fallbackId);
  }

  async ensureCubeIds(graph) {
    if (!graph) {
      return { assigned: [], replacements: new Map() };
    }
    const builder =
      this.instanceManager?.instanceBuilder ||
      new InstanceBuilder({ logger: this.adapter?.getConsole?.() });
    const instances = builder.build(graph);
    const assigned = [];
    const replacements = new Map();
    const assignedIds = new Set();
    for (const instance of instances) {
      if (instance.cubeId && isCanonicalCubeId(instance.cubeId)) {
        continue;
      }
      const defaultAlias = instance.defaultAlias || 'SugarCube';
      const cubeId = await this.promptForCanonicalCubeId({
        defaultAlias,
        currentCubeId: instance.cubeId,
      });
      if (!cubeId) {
        throw new Error(`Canonical cube id is required before saving '${defaultAlias}'.`);
      }
      if (instance.cubeId) {
        replacements.set(instance.cubeId, cubeId);
      }
      const updated = updateMarkersForIds(graph, instance.markerIds, { cubeId });
      if (updated) {
        assigned.push({ cubeId, instanceId: instance.instanceId });
        assignedIds.add(cubeId);
      }
    }
    const nodes = Array.isArray(graph._nodes) ? graph._nodes : graph.nodes || [];
    const fallbackByName = new Map();
    for (const node of nodes) {
      if (!isCubeMarkerType(node)) {
        continue;
      }
      const defaultAlias = readWidgetValue(node, 'default_alias');
      if (!defaultAlias) {
        continue;
      }
      const cubeId = readWidgetValue(node, 'cube_id');
      const entry = fallbackByName.get(defaultAlias) || {
        defaultAlias,
        cubeId: cubeId || '',
        markerIds: [],
      };
      if (cubeId && !entry.cubeId) {
        entry.cubeId = cubeId;
      }
      if (!cubeId) {
        entry.markerIds.push(node.id);
      }
      fallbackByName.set(defaultAlias, entry);
    }
    for (const entry of fallbackByName.values()) {
      if (!entry.markerIds.length) {
        continue;
      }
      const shouldReplace = entry.cubeId && !isCanonicalCubeId(entry.cubeId);
      const cubeId = shouldReplace
        ? await this.promptForCanonicalCubeId({
            defaultAlias: entry.defaultAlias,
            currentCubeId: entry.cubeId,
          })
        : entry.cubeId;
      if (shouldReplace) {
        if (!cubeId) {
          throw new Error(`Canonical cube id is required before saving '${entry.defaultAlias}'.`);
        }
        replacements.set(entry.cubeId, cubeId);
      }
      if (!cubeId) {
        const promptedId = await this.promptForCanonicalCubeId({
          defaultAlias: entry.defaultAlias,
        });
        if (!promptedId) {
          throw new Error(`Canonical cube id is required before saving '${entry.defaultAlias}'.`);
        }
        const updated = updateMarkersForIds(graph, entry.markerIds, { cubeId: promptedId });
        if (updated && !assignedIds.has(promptedId)) {
          assigned.push({ cubeId: promptedId, instanceId: null });
          assignedIds.add(promptedId);
        }
        continue;
      }
      const updated = updateMarkersForIds(graph, entry.markerIds, { cubeId });
      if (updated && !assignedIds.has(cubeId)) {
        assigned.push({ cubeId, instanceId: null });
        assignedIds.add(cubeId);
      }
    }
    if (assigned.length) {
      this.instanceManager?.scheduleRefresh?.({ graph, reason: 'cube-id-assigned' });
      this.dirtyManager?.scheduleRefresh?.({ graph, reason: 'cube-id-assigned' });
    }
    return { assigned, replacements };
  }

  async promptForCanonicalCubeId({
    defaultAlias,
    currentCubeId = '',
    promptLabel = '',
    targetModel = DEFAULT_TARGET_MODEL,
  } = {}) {
    const suggestedPath = this.deriveCreateCubeId(
      defaultAlias || 'cube',
      DEFAULT_LOCAL_CREATE_DESTINATION,
      targetModel,
    );
    const initialValue =
      typeof currentCubeId === 'string' && currentCubeId.trim()
        ? currentCubeId.trim()
        : suggestedPath;
    const result = await this.dialogs?.promptText?.({
      title: 'SugarCube Identifier',
      message: [promptLabel || 'Provide a canonical SugarCube id before saving this cube.'],
      label: 'SugarCube id',
      helperText:
        'Use owner/repo/Target Model/Cube Name.cube or local/namespace/Target Model/Cube Name.cube.',
      placeholder: 'owner/repo/SDXL/Text to Image.cube',
      initialValue,
      confirmLabel: 'Save Id',
      normalizeValue: (value) => value.trim(),
    });
    const trimmed = typeof result === 'string' ? result.trim() : '';
    if (!trimmed) {
      return '';
    }
    if (!isCanonicalCubeId(trimmed)) {
      throw new Error(
        'Cube id must use canonical owner/repo/Target Model/Cube Name.cube or local/namespace/Target Model/Cube Name.cube format before save.',
      );
    }
    return trimmed;
  }

  pushToastMessage(severity, summary, detail) {
    this.toast?.push?.(severity, summary, detail);
  }

  formatSaveSummaryEntry(entry) {
    const prefix = entry?.committed ? 'saved and committed' : 'saved only';
    const defaultAlias =
      typeof entry?.default_alias === 'string' && entry.default_alias
        ? entry.default_alias
        : 'SugarCube';
    const path = typeof entry?.path === 'string' ? entry.path : '';
    const commitSuffix =
      entry?.committed && entry?.commit_short_sha
        ? ` (${entry.commit_short_sha}: ${entry.commit_message || 'committed'})`
        : entry?.commit_error
          ? ` (commit failed: ${entry.commit_error})`
          : '';
    return `${prefix}: ${defaultAlias} -> ${path}${commitSuffix}`;
  }

  isWritableEntry(entry) {
    return Boolean(entry?.is_writable);
  }

  buildForkedName(baseName, usedNames) {
    const base = typeof baseName === 'string' && baseName.trim() ? baseName.trim() : 'SugarCube';
    const used = usedNames instanceof Set ? usedNames : new Set();
    const fallback = `${base} (fork)`;
    if (!used.has(fallback)) {
      return fallback;
    }
    let index = 2;
    while (index < 1000) {
      const next = `${base} (fork ${index})`;
      if (!used.has(next)) {
        return next;
      }
      index += 1;
    }
    return `${base} (fork ${Date.now()})`;
  }

  buildLineagePayload(entry) {
    if (!entry || typeof entry !== 'object') {
      return null;
    }
    return {
      id: entry.cube_id || '',
      name: entry.name || '',
      version: entry.version || '',
      author: entry.author || '',
      author_url: entry.author_url || '',
      forked_at: new Date().toISOString(),
    };
  }

  buildHistoricalLineagePayload(browserEntry, saveEntry) {
    const entry = saveEntry && typeof saveEntry === 'object' ? saveEntry : {};
    const source = browserEntry && typeof browserEntry === 'object' ? browserEntry : {};
    return {
      id: entry.previousCubeId || source.cube_id || '',
      name: entry.defaultAlias || source.name || '',
      version: entry.sourceVersion || source.version || '',
      revision_ref: entry.sourceRevisionRef || '',
      author: source.author || '',
      author_url: source.author_url || '',
      forked_at: new Date().toISOString(),
    };
  }

  buildCubeEntryIndex(entries) {
    const map = new Map();
    const list = Array.isArray(entries) ? entries : [];
    for (const entry of list) {
      const cubeId = typeof entry?.cube_id === 'string' ? entry.cube_id.trim() : '';
      if (!cubeId) {
        continue;
      }
      map.set(cubeId, entry);
    }
    return map;
  }

  buildErrorDetail(errorPayload) {
    if (!errorPayload) {
      return '';
    }
    if (typeof errorPayload.detail === 'string' && errorPayload.detail) {
      return errorPayload.detail;
    }
    if (errorPayload.details && typeof errorPayload.details === 'object') {
      try {
        return JSON.stringify(errorPayload.details);
      } catch (_error) {
        return '';
      }
    }
    return '';
  }

  formatViolations(violations) {
    if (!Array.isArray(violations) || violations.length === 0) {
      return '';
    }
    const lines = violations.map((entry) => {
      const from = this.formatEndpoint(entry?.from);
      const to = this.formatEndpoint(entry?.to);
      return `${from} -> ${to}`;
    });
    return lines.join('\n');
  }

  formatEndpoint(endpoint) {
    if (!endpoint || typeof endpoint !== 'object') {
      return '<unknown>';
    }
    const parts = [];
    if (endpoint.title) {
      parts.push(endpoint.title);
    }
    if (endpoint.cube) {
      parts.push(`[${endpoint.cube}]`);
    }
    if (endpoint.port !== undefined) {
      parts.push(`(${endpoint.port})`);
    }
    if (!parts.length && endpoint.id) {
      parts.push(String(endpoint.id));
    }
    return parts.join(' ') || '<unknown>';
  }

  loadAuthorProfile() {
    try {
      if (!this.storage) {
        return null;
      }
      const parsed = this.storage.readJson(CUBE_AUTHOR_PROFILE_KEY);
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      const author = typeof parsed.author === 'string' ? parsed.author.trim() : '';
      const authorUrl = typeof parsed.author_url === 'string' ? parsed.author_url.trim() : '';
      if (!author) {
        return null;
      }
      return { author, author_url: authorUrl };
    } catch (_error) {
      return null;
    }
  }

  getAuthorProfile() {
    return this.loadAuthorProfile();
  }

  persistAuthorProfile(profile) {
    try {
      if (!this.storage) {
        return;
      }
      if (!profile || typeof profile !== 'object') {
        return;
      }
      this.storage.writeJson(CUBE_AUTHOR_PROFILE_KEY, profile);
    } catch (_error) {
      // ignore storage failures
    }
  }

  async promptForAuthorProfile() {
    const values = await this.dialogs?.openForm?.({
      title: 'Author Profile',
      message: ['Add author details before saving SugarCubes from this workspace.'],
      confirmLabel: 'Save Profile',
      fields: [
        {
          key: 'author',
          label: 'Author name',
          required: true,
          normalizeValue: (value) => value.trim(),
        },
        {
          key: 'authorUrl',
          label: 'Author URL',
          type: 'url',
          normalizeValue: (value) => value.trim(),
        },
      ],
    });
    if (!values?.author) {
      return null;
    }
    return { author: values.author, author_url: values.authorUrl || '' };
  }

  async ensureAuthorProfile() {
    const stored = this.loadAuthorProfile();
    if (stored?.author) {
      return stored;
    }
    const prompted = await this.promptForAuthorProfile();
    if (!prompted?.author) {
      return null;
    }
    this.persistAuthorProfile(prompted);
    return prompted;
  }
}

class SugarCubeExportError extends Error {
  constructor(message, detail = '', violations = undefined) {
    super(message);
    this.detail = detail;
    this.violations = violations;
  }

  static from(error) {
    if (!error) {
      return new SugarCubeExportError('Export failed');
    }
    if (error instanceof SugarCubeExportError) {
      return error;
    }
    if (typeof error === 'object') {
      const message =
        typeof error.message === 'string' && error.message ? error.message : 'Export failed';
      const detail = typeof error.detail === 'string' ? error.detail : '';
      const violations = Array.isArray(error.violations) ? error.violations : undefined;
      return new SugarCubeExportError(message, detail, violations);
    }
    return new SugarCubeExportError(String(error));
  }
}
