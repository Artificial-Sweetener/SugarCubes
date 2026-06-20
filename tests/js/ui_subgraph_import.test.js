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
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { app } from './mocks/app.js';
import { api } from './mocks/api.js';
import { getSugarCubesUI } from '../../web/comfyui/ui/index.js';

function createGraph() {
  let nextNodeId = 1000;
  let nextLinkId = 1;
  const graph = {
    _nodes: [],
    _groups: [],
    _subgraphs: new Map(),
    links: {},
    beforeChange: jest.fn(),
    afterChange: jest.fn(),
    setDirtyCanvas: jest.fn(),
    add(item) {
      if (item && Array.isArray(item.bounding)) {
        this._groups.push(item);
      } else {
        item.graph = this;
        if (!Number.isInteger(item.id) || item.id < 0) {
          item.id = nextNodeId++;
        }
        this._nodes.push(item);
      }
      return item;
    },
    getNodeById(id) {
      return this._nodes.find((node) => node?.id === id) || null;
    },
    createSubgraph(entry) {
      if (!entry?.inputNode?.bounding || !entry?.outputNode?.bounding) {
        throw new Error("Cannot read properties of undefined (reading 'bounding')");
      }
      const subgraph = {
        id: entry.id,
        data: null,
        configure: jest.fn(function configure(data) {
          this.data = data;
        }),
      };
      this._subgraphs.set(entry.id, subgraph);
      return subgraph;
    },
  };

  function connectNodes(fromNode, outputIndex, toNode, inputIndex) {
    const linkId = nextLinkId++;
    graph.links[linkId] = {
      id: linkId,
      origin_id: fromNode.id,
      origin_slot: outputIndex,
      target_id: toNode.id,
      target_slot: inputIndex,
      type: fromNode.outputs?.[outputIndex]?.type || '*',
    };
    fromNode.outputs[outputIndex].links = fromNode.outputs[outputIndex].links || [];
    fromNode.outputs[outputIndex].links.push(linkId);
    toNode.inputs[inputIndex].link = linkId;
    return graph.links[linkId];
  }

  function makeNode(type, schema = {}) {
    return {
      id: -1,
      type,
      title: schema.title || type,
      pos: [0, 0],
      size: [180, 60],
      properties: {},
      widgets: (schema.widgets || []).map((widget) =>
        typeof widget === 'string' ? { name: widget, value: '' } : { ...widget },
      ),
      inputs: (schema.inputs || []).map((slot) => ({ ...slot, link: null })),
      outputs: (schema.outputs || []).map((slot) => ({ ...slot, links: [] })),
      connect(outputIndex, targetNode, inputIndex) {
        return connectNodes(this, outputIndex, targetNode, inputIndex);
      },
    };
  }

  return { graph, makeNode };
}

function installLiteGraph(graph, makeNode) {
  const builtins = new Map([
    [
      'String',
      {
        title: 'String',
        inputs: [{ name: 'value', type: 'STRING' }],
        outputs: [{ name: 'STRING', type: 'STRING' }],
      },
    ],
    [
      'DisplayString',
      {
        title: 'DisplayString',
        inputs: [{ name: 'value', type: 'STRING' }],
        outputs: [],
      },
    ],
    [
      'CheckpointLoaderSimple',
      {
        title: 'Load Checkpoint',
        widgets: [{ name: 'ckpt_name', value: 'local-default.safetensors' }],
        inputs: [],
        outputs: [{ name: 'MODEL', type: 'MODEL' }],
      },
    ],
    [
      'PrimitiveStringMultiline',
      {
        title: 'PrimitiveStringMultiline',
        widgets: [{ name: 'value', value: 'local prompt' }],
        inputs: [],
        outputs: [{ name: 'STRING', type: 'STRING' }],
      },
    ],
    [
      'SugarCubes.CubeInput',
      {
        title: 'SugarCubes.CubeInput',
        widgets: ['cube_id', 'default_alias', 'instance_alias', 'instance_id'],
        inputs: [],
        outputs: [{ name: 'value', type: 'STRING' }],
      },
    ],
    [
      'SugarCubes.CubeOutput',
      {
        title: 'SugarCubes.CubeOutput',
        widgets: ['cube_id', 'default_alias', 'instance_alias', 'instance_id'],
        inputs: [{ name: 'value', type: 'STRING' }],
        outputs: [],
      },
    ],
  ]);

  globalThis.LiteGraph = {
    LGraphCanvas: function LGraphCanvas() {},
    LGraphGroup: function LGraphGroup(title) {
      this.title = title;
      this.bounding = [0, 0, 0, 0];
    },
    LinkDirection: { LEFT: 3, RIGHT: 4 },
    createNode(type) {
      if (graph._subgraphs.has(type)) {
        const subgraph = graph._subgraphs.get(type);
        const data = subgraph?.data || {};
        return makeNode(type, {
          title: data.name || type,
          inputs: Array.isArray(data.inputs)
            ? data.inputs.map((slot) => ({ name: slot.name, type: slot.type }))
            : [],
          outputs: Array.isArray(data.outputs)
            ? data.outputs.map((slot) => ({ name: slot.name, type: slot.type }))
            : [],
        });
      }

      const schema = builtins.get(type);
      return schema ? makeNode(type, schema) : null;
    },
  };
  globalThis.LiteGraph.LGraphCanvas.prototype.drawConnections = () => {};
  globalThis.LiteGraph.LGraphCanvas.prototype.drawForeground = () => {};
}

async function loadUi() {
  const cacheBust = `?v=${Math.random().toString(36).slice(2)}`;
  return import(`../../web/comfyui/ui.js${cacheBust}`);
}

async function flushPromises() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  app.reset();
  const { graph, makeNode } = createGraph();
  app.graph = graph;
  installLiteGraph(graph, makeNode);
  app.canvas = {
    graph,
    setDirty: jest.fn(),
    onAfterChange: () => {},
    onDrawForeground: () => {},
    onDrawBackground: () => {},
    processMouseMove: () => {},
    processMouseDown: () => {},
    centerOnNode: jest.fn(),
  };
  app.extensionManager = { registerSidebarTab: () => {} };
  app.clean = () => {};

  localStorage.clear();
  document.body.innerHTML = '';
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  window.cancelAnimationFrame = globalThis.cancelAnimationFrame;
  window.SugarCubes = {};
  window.setInterval = () => 1;
  window.clearInterval = () => {};
  window.alert = () => {};
  window.comfyAPI = { vueApp: { config: { globalProperties: { $toast: null } } } };
  HTMLCanvasElement.prototype.getContext = () => ({
    clearRect: () => {},
    fillRect: () => {},
    strokeRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    save: () => {},
    restore: () => {},
    setLineDash: () => {},
    drawImage: () => {},
    fillText: () => {},
  });

  api.fetchApi = async () => ({ ok: true, json: async () => ({ cubes: [] }) });
});

describe('legacy subgraph import compatibility', () => {
  test('applyPreparedImport normalizes legacy subgraphs before registering wrapper nodes', async () => {
    await loadUi();
    const extension = app._extensions[0];
    await extension.setup();

    const ui = getSugarCubesUI();
    const applyPreparedImport = ui.overlayManager?.placement?.applyPreparedImport;
    expect(typeof applyPreparedImport).toBe('function');

    const subgraphId = '53a1ec2c-66e1-49df-ae27-f197482ba76d';
    const payload = {
      cube: { cube_id: 'artificial-sweetener/base-cubes/diffusion upscale.cube' },
      subgraphs: [
        {
          id: subgraphId,
          revision: 0,
          last_node_id: 11,
          last_link_id: 3,
          version: 0.4,
          nodes: [
            {
              id: 10,
              type: 'String',
              pos: [120, 120],
              size: [140, 60],
              flags: {},
              order: 0,
              mode: 0,
              inputs: [{ name: 'value', type: 'STRING', link: null }],
              outputs: [{ name: 'STRING', type: 'STRING', links: [3] }],
            },
            {
              id: 11,
              type: 'DisplayString',
              pos: [340, 120],
              size: [180, 60],
              flags: {},
              order: 1,
              mode: 0,
              inputs: [
                { name: 'string', type: 'STRING', link: 1 },
                { name: 'string_alt', type: 'STRING', link: 2 },
              ],
              outputs: [],
            },
          ],
          links: [
            [1, -10, 0, 11, 0, 'STRING'],
            [2, -10, 1, 11, 1, 'STRING'],
            [3, 10, 0, -20, 0, 'STRING'],
          ],
          groups: [],
          config: {},
          extra: {},
          inputs: [],
          outputs: [],
        },
      ],
      nodes: [
        {
          symbol: 'prompt',
          class_type: 'String',
          inputs: {},
          extras: { original_id: '1', _meta: { title: 'Prompt' } },
          layout: { id: 1, pos: [0, 0], size: [180, 60], title: 'Prompt' },
        },
        {
          symbol: 'negative',
          class_type: 'String',
          inputs: {},
          extras: { original_id: '2', _meta: { title: 'Negative' } },
          layout: { id: 2, pos: [0, 120], size: [180, 60], title: 'Negative' },
        },
        {
          symbol: 'wrapper',
          class_type: subgraphId,
          inputs: {
            positive: ['prompt', 0],
            negative: ['negative', 0],
          },
          extras: { original_id: '3', _meta: { title: 'Schedule & Encode Prompts' } },
          layout: {
            id: 3,
            pos: [320, 60],
            size: [220, 80],
            title: 'Schedule & Encode Prompts',
          },
        },
        {
          symbol: 'sink',
          class_type: 'DisplayString',
          inputs: {},
          extras: { original_id: '4', _meta: { title: 'Sink' } },
          layout: { id: 4, pos: [620, 60], size: [180, 60], title: 'Sink' },
        },
      ],
      markers: [],
      connections: [
        { from: { symbol: 'prompt', slot: 0 }, to: { symbol: 'wrapper', input: 'positive' } },
        { from: { symbol: 'negative', slot: 0 }, to: { symbol: 'wrapper', input: 'negative' } },
        { from: { symbol: 'wrapper', slot: 0 }, to: { symbol: 'sink', input: 'value' } },
      ],
      layout: { origin: [0, 0], groups: [] },
      warnings: [],
    };

    const result = await applyPreparedImport(payload, {
      defaultAlias: 'diffusion upscale',
      dropOrigin: [0, 0],
    });
    await flushPromises();

    expect(result.success).toBe(true);
    expect(result.missingTypes).toEqual([]);
    expect(result.warnings).not.toContain(
      expect.stringContaining(`Failed to register subgraph '${subgraphId}'`),
    );
    expect(result.warnings).not.toContain(
      expect.stringContaining(`Node type '${subgraphId}' is unavailable`),
    );

    const registered = app.graph._subgraphs.get(subgraphId);
    expect(registered).toBeTruthy();
    expect(registered.configure).toHaveBeenCalledWith(
      expect.objectContaining({
        id: subgraphId,
        name: 'Schedule & Encode Prompts',
        inputNode: expect.objectContaining({
          id: -10,
          bounding: expect.any(Array),
        }),
        outputNode: expect.objectContaining({
          id: -20,
          bounding: expect.any(Array),
        }),
        inputs: [
          expect.objectContaining({ name: 'positive', type: 'STRING' }),
          expect.objectContaining({ name: 'negative', type: 'STRING' }),
        ],
        outputs: [expect.objectContaining({ name: 'STRING', type: 'STRING' })],
      }),
    );

    const wrapperNode = app.graph._nodes.find((node) => node.type === subgraphId);
    expect(wrapperNode).toBeTruthy();
    expect(wrapperNode.inputs.map((slot) => slot.name)).toEqual(['positive', 'negative']);
    expect(wrapperNode.outputs.map((slot) => slot.name)).toEqual(['STRING']);
    expect(result.connectionsMade).toBe(3);
  });

  test('applyPreparedImport remaps imported group metadata to actual created node ids', async () => {
    await loadUi();
    const extension = app._extensions[0];
    await extension.setup();

    const ui = getSugarCubesUI();
    ui.instanceManager.refresh = jest.fn();
    const applyPreparedImport = ui.overlayManager?.placement?.applyPreparedImport;
    expect(typeof applyPreparedImport).toBe('function');

    app.graph._nodes.push({ id: 1 }, { id: 2 }, { id: 3 });

    const payload = {
      cube: { cube_id: 'local/example-user/demo.cube', version: '1.0.0' },
      nodes: [
        {
          symbol: 'body',
          class_type: 'String',
          inputs: {},
          extras: { original_id: '1', _meta: { title: 'Body' } },
          layout: { id: 1, pos: [100, 100], size: [180, 60], title: 'Body' },
        },
      ],
      markers: [
        {
          alias: 'input.value',
          class_type: 'SugarCubes.CubeInput',
          widget_values: {
            cube_id: 'local/example-user/demo.cube',
            default_alias: 'Demo',
            instance_alias: 'Demo',
            instance_id: 'inst-imported',
          },
          layout: { id: 2, pos: [0, 100], size: [120, 40], title: 'Input' },
        },
        {
          alias: 'output.value',
          class_type: 'SugarCubes.CubeOutput',
          widget_values: {
            cube_id: 'local/example-user/demo.cube',
            default_alias: 'Demo',
            instance_alias: 'Demo',
            instance_id: 'inst-imported',
          },
          layout: { id: 3, pos: [320, 100], size: [120, 40], title: 'Output' },
        },
      ],
      connections: [
        { from: { symbol: 'input.value', slot: 0 }, to: { symbol: 'body', input: 'value' } },
        { from: { symbol: 'body', slot: 0 }, to: { symbol: 'output.value', input: 'value' } },
      ],
      layout: {
        origin: [0, 0],
        groups: [
          {
            bounding: [-40, 40, 520, 160],
            sugarcubes: {
              managed: true,
              instance_id: 'inst-imported',
              cube_id: 'local/example-user/demo.cube',
              default_alias: 'SDXL/Demo',
              instance_alias: 'Demo',
              markers: { inputs: [2], outputs: [3] },
              nodes: [1],
              bounds: { x: -40, y: 40, w: 520, h: 160 },
            },
          },
        ],
      },
      warnings: [],
    };

    const result = await applyPreparedImport(payload, {
      instanceAlias: 'Demo',
      dropOrigin: [0, 0],
    });

    expect(result.success).toBe(true);
    expect(app.graph._groups).toHaveLength(1);
    const metadata = app.graph._groups[0].properties?.sugarcubes;
    expect(metadata.markers).toEqual({
      inputs: [1001],
      outputs: [1002],
    });
    expect(metadata.nodes).toEqual([1000]);
    expect(metadata.markers.inputs).not.toContain(2);
    expect(metadata.markers.outputs).not.toContain(3);
    expect(metadata.nodes).not.toContain(1);
  });

  test('applyPreparedImport restores node execution mode', async () => {
    await loadUi();
    const extension = app._extensions[0];
    await extension.setup();

    const ui = getSugarCubesUI();
    const applyPreparedImport = ui.overlayManager?.placement?.applyPreparedImport;
    const payload = {
      cube: { cube_id: 'local/example-user/mode.cube', version: '1.0.0' },
      nodes: [
        {
          symbol: 'body',
          class_type: 'String',
          inputs: {},
          mode: 4,
          extras: { original_id: '1' },
          layout: { id: 1, pos: [100, 100], size: [180, 60], title: 'Body' },
        },
      ],
      markers: [],
      connections: [],
      layout: { origin: [0, 0], groups: [] },
      warnings: [],
    };

    const result = await applyPreparedImport(payload, { dropOrigin: [0, 0] });

    expect(result.success).toBe(true);
    expect(app.graph._nodes.find((node) => node.properties?.sugarcubes_symbol === 'body')?.mode).toBe(
      4,
    );
  });

  test('applyPreparedImport leaves missing picker values at local defaults', async () => {
    await loadUi();
    const extension = app._extensions[0];
    await extension.setup();

    const ui = getSugarCubesUI();
    const applyPreparedImport = ui.overlayManager?.placement?.applyPreparedImport;
    const payload = {
      cube: { cube_id: 'local/example-user/defaults.cube', version: '1.0.0' },
      nodes: [
        {
          symbol: 'checkpoint',
          class_type: 'CheckpointLoaderSimple',
          inputs: {},
          extras: { original_id: '1' },
          layout: { id: 1, pos: [100, 100], size: [180, 60], title: 'Checkpoint' },
        },
      ],
      markers: [],
      connections: [],
      layout: { origin: [0, 0], groups: [] },
      warnings: [],
    };

    const result = await applyPreparedImport(payload, { dropOrigin: [0, 0] });

    expect(result.success).toBe(true);
    const node = app.graph._nodes.find(
      (entry) => entry.properties?.sugarcubes_symbol === 'checkpoint',
    );
    expect(node.widgets.find((widget) => widget.name === 'ckpt_name')?.value).toBe(
      'local-default.safetensors',
    );
  });

  test('applyPreparedImport applies present picker and blank text values', async () => {
    await loadUi();
    const extension = app._extensions[0];
    await extension.setup();

    const ui = getSugarCubesUI();
    const applyPreparedImport = ui.overlayManager?.placement?.applyPreparedImport;
    const payload = {
      cube: { cube_id: 'local/example-user/authored.cube', version: '1.0.0' },
      nodes: [
        {
          symbol: 'checkpoint',
          class_type: 'CheckpointLoaderSimple',
          inputs: { ckpt_name: 'authored.safetensors' },
          extras: { original_id: '1' },
          layout: { id: 1, pos: [100, 100], size: [180, 60], title: 'Checkpoint' },
        },
        {
          symbol: 'prompt',
          class_type: 'PrimitiveStringMultiline',
          inputs: { value: '' },
          extras: { original_id: '2' },
          layout: { id: 2, pos: [320, 100], size: [180, 60], title: 'Prompt' },
        },
      ],
      markers: [],
      connections: [],
      layout: { origin: [0, 0], groups: [] },
      warnings: [],
    };

    const result = await applyPreparedImport(payload, { dropOrigin: [0, 0] });

    expect(result.success).toBe(true);
    const checkpoint = app.graph._nodes.find(
      (entry) => entry.properties?.sugarcubes_symbol === 'checkpoint',
    );
    const prompt = app.graph._nodes.find(
      (entry) => entry.properties?.sugarcubes_symbol === 'prompt',
    );
    expect(checkpoint.widgets.find((widget) => widget.name === 'ckpt_name')?.value).toBe(
      'authored.safetensors',
    );
    expect(prompt.widgets.find((widget) => widget.name === 'value')?.value).toBe('');
  });

  test('applyPreparedImport uses route default alias for new placements', async () => {
    await loadUi();
    const extension = app._extensions[0];
    await extension.setup();

    const ui = getSugarCubesUI();
    ui.instanceManager.refresh = jest.fn();
    const applyPreparedImport = ui.overlayManager?.placement?.applyPreparedImport;

    const payload = {
      cube: {
        cube_id: 'local/example-user/SDXL/demo.cube',
        version: '1.0.0',
        target_model: 'SDXL',
        default_alias: 'SDXL/Demo',
      },
      nodes: [
        {
          symbol: 'body',
          class_type: 'String',
          inputs: {},
          extras: { original_id: '1' },
          layout: { id: 1, pos: [100, 100], size: [180, 60], title: 'Body' },
        },
      ],
      markers: [],
      connections: [],
      layout: {
        origin: [0, 0],
        groups: [
          {
            title: 'Polluted Instance Alias',
            bounding: [80, 80, 220, 120],
            sugarcubes: {
              managed: true,
              instance_id: 'inst-imported',
              cube_id: 'local/example-user/SDXL/demo.cube',
              default_alias: 'Demo',
              instance_alias: 'Polluted Instance Alias',
              markers: {},
              nodes: [1],
            },
          },
        ],
      },
      warnings: [],
    };

    const result = await applyPreparedImport(payload, { dropOrigin: [0, 0] });

    expect(result.success).toBe(true);
    expect(app.graph._groups).toHaveLength(1);
    expect(app.graph._groups[0].title).toBe('SDXL/Demo');
    expect(app.graph._groups[0].properties?.sugarcubes?.instance_alias).toBe('SDXL/Demo');
    expect(app.graph._groups[0].properties?.sugarcubes?.default_alias).toBe('SDXL/Demo');
    expect(app.graph._groups[0].properties?.sugarcubes?.target_model).toBe('SDXL');
  });
});
