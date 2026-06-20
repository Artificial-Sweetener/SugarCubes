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
 * Own the SugarCubes UI orchestration layer in `web/comfyui/ui/SugarCubesUI.js`.
 */

import { ComfyAdapter } from './core/ComfyAdapter.js';
import { EventBus } from './core/EventBus.js';
import { Scheduler } from './core/Scheduler.js';
import { ToastService } from './core/ToastService.js';
import { StorageService } from './core/StorageService.js';
import { CubeLibraryApi } from './core/CubeLibraryApi.js';
import { OverlayManager } from './overlays/OverlayManager.js';
import { CubeBrowserController } from './browser/CubeBrowserController.js';
import { ConfirmDialog } from './dialogs/ConfirmDialog.js';
import { ModalService } from './dialogs/ModalService.js';
import { VersionDialog } from './dialogs/VersionDialog.js';
import { InstanceManager } from './graph/InstanceManager.js';
import { DirtyManager } from './graph/DirtyManager.js';
import { CubeActionService } from './CubeActionService.js';
import { CubeLayoutService } from './layout/CubeLayoutService.js';
import { CubeContainmentService } from './layout/CubeContainmentService.js';
import { CubeCollisionService } from './layout/CubeCollisionService.js';
import { CubeBoundsReconciler } from './layout/CubeBoundsReconciler.js';
import { FlavorService } from './flavors/FlavorService.js';

/**
 * Coordinate sugar cubes ui behavior for the SugarCubes UI.
 */
export class SugarCubesUI {
  constructor(options = {}) {
    this.adapter = options.adapter || new ComfyAdapter(options);
    this.events = options.events || new EventBus();
    this.scheduler = options.scheduler || new Scheduler(this.adapter);
    this.storage = options.storage || new StorageService(this.adapter);
    this.api = options.cubeApi || new CubeLibraryApi(this.adapter);
    this.dialogs = options.dialogs || new ModalService({ adapter: this.adapter });
    this.toast = options.toast || new ToastService(this.adapter, { dialogs: this.dialogs });
    this.confirmDialog = this.dialogs.confirmDialog || new ConfirmDialog({ adapter: this.adapter });
    this.versionDialog = new VersionDialog({ adapter: this.adapter, storage: this.storage });
    this._setupDone = false;

    this.cubeBrowser = new CubeBrowserController({
      adapter: this.adapter,
      api: this.api,
      events: this.events,
      storage: this.storage,
      toast: this.toast,
      scheduler: this.scheduler,
    });

    this.instanceManager = new InstanceManager({
      adapter: this.adapter,
      events: this.events,
      scheduler: this.scheduler,
      requestDirtyRefresh: (opts) => this.dirtyManager.requestRefresh(opts),
    });

    this.dirtyManager = new DirtyManager({
      adapter: this.adapter,
      events: this.events,
      scheduler: this.scheduler,
      cubeBrowser: this.cubeBrowser,
      cubeApi: this.api,
    });

    this.flavorService = new FlavorService({
      adapter: this.adapter,
      dialogs: this.dialogs,
      events: this.events,
      storage: this.storage,
      toast: this.toast,
      api: this.api,
      dirtyManager: this.dirtyManager,
      cubeBrowser: this.cubeBrowser,
    });

    this.cubeActions = new CubeActionService({
      adapter: this.adapter,
      api: this.api,
      storage: this.storage,
      toast: this.toast,
      instanceManager: this.instanceManager,
      dirtyManager: this.dirtyManager,
      cubeBrowser: this.cubeBrowser,
      versionDialog: this.versionDialog,
      dialogs: this.dialogs,
      flavorService: this.flavorService,
    });

    this.layoutService = new CubeLayoutService({
      adapter: this.adapter,
      instanceManager: this.instanceManager,
      dirtyManager: this.dirtyManager,
    });

    this.containmentService = new CubeContainmentService();
    this.collisionService = new CubeCollisionService();
    this.boundsReconciler = new CubeBoundsReconciler();

    this.overlayManager = new OverlayManager({
      adapter: this.adapter,
      events: this.events,
      scheduler: this.scheduler,
      storage: this.storage,
      api: this.adapter?.getApi?.(),
      cubeApi: this.api,
      cubeBrowser: this.cubeBrowser,
      cubeActions: this.cubeActions,
      flavorService: this.flavorService,
      toast: this.toast,
      applyPreparedImport: options.applyPreparedImport,
      reportImportOutcome: options.reportImportOutcome,
      buildShiftedPlacementPayload: options.buildShiftedPlacementPayload,
      requestDirtyRefresh: (opts) => this.dirtyManager.requestRefresh(opts),
      layoutService: this.layoutService,
      containmentService: this.containmentService,
      collisionService: this.collisionService,
      boundsReconciler: this.boundsReconciler,
    });
  }

  async setup() {
    if (this._setupDone) {
      return;
    }
    await this.cubeBrowser.setup();
    this.instanceManager.setup();
    this.dirtyManager.setup();
    await this.flavorService.setup();
    this.events.on('cube:instances:refresh', (options) => {
      this.instanceManager.scheduleRefresh(options);
    });
    this.overlayManager.setup();
    this._setupDone = true;
  }

  dispose() {
    this.overlayManager.dispose();
    this.cubeBrowser.dispose();
    this.dirtyManager.dispose();
    this.flavorService.dispose();
  }

  async listCubes() {
    const { data } = await this.api.list();
    return data;
  }

  async previewCube(cubeId) {
    const { data } = await this.api.preview(cubeId);
    return data;
  }

  openLibrary(options = {}) {
    return this.cubeBrowser.open(options);
  }

  scheduleCubeInstanceRefresh(options = {}) {
    this.instanceManager.scheduleRefresh(options);
  }

  scheduleCubeDirtyRefresh(options = {}) {
    this.dirtyManager.requestRefresh(options);
  }
}
