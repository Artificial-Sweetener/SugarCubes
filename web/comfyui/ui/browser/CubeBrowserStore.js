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
 * Own the SugarCubes cube browser layer in `web/comfyui/ui/browser/CubeBrowserStore.js`.
 */

/**
 * Coordinate cube browser store behavior for the SugarCubes UI.
 */
export class CubeBrowserStore {
  constructor() {
    this.state = {
      initialized: false,
      loading: false,
      busy: false,
      error: null,
      cubes: [],
      filtered: [],
      grouped: [],
      selected: null,
      favorites: new Set(),
      recents: [],
      modelOptions: [],
      searchQuery: '',
      editing: false,
      editDraft: null,
      dirtyCubeIds: new Set(),
      lastFetched: 0,
      authorGroupsOpen: new Set(),
      authorGroupsTouched: false,
      dropOrigin: [0, 0],
      revisions: [],
      revisionsLoading: false,
      selectedRevision: 'WORKTREE',
      revisionsCubeId: null,
      versionOptions: [],
      selectedVersion: '',
      versionError: null,
    };
  }

  hydrate(next) {
    this.state = { ...this.state, ...next };
  }

  update(patch) {
    this.state = { ...this.state, ...patch };
  }

  setInitialized(value) {
    this.update({ initialized: Boolean(value) });
  }

  setLoading(value) {
    this.update({ loading: Boolean(value) });
  }

  setBusy(value) {
    this.update({ busy: Boolean(value) });
  }

  setError(message) {
    this.update({ error: message || null });
  }

  setCubes(cubes) {
    this.update({ cubes: Array.isArray(cubes) ? cubes : [] });
  }

  setFiltered(filtered) {
    this.update({ filtered: Array.isArray(filtered) ? filtered : [] });
  }

  setGrouped(groups) {
    this.update({ grouped: Array.isArray(groups) ? groups : [] });
  }

  setSelected(name) {
    this.update({ selected: name || null });
  }

  setFavorites(favorites) {
    this.update({ favorites: new Set(favorites || []) });
  }

  setRecents(recents) {
    this.update({ recents: Array.isArray(recents) ? recents : [] });
  }

  setModelOptions(options) {
    this.update({ modelOptions: Array.isArray(options) ? options : [] });
  }

  setSearchQuery(query) {
    this.update({ searchQuery: query || '' });
  }

  setEditing(editing, draft = null) {
    this.update({ editing: Boolean(editing), editDraft: draft });
  }

  setDirtyCubeIds(dirtyCubeIds) {
    this.update({ dirtyCubeIds: dirtyCubeIds instanceof Set ? dirtyCubeIds : new Set() });
  }

  setLastFetched(timestamp) {
    this.update({ lastFetched: Number(timestamp) || 0 });
  }

  setAuthorGroupsOpen(groups) {
    this.update({ authorGroupsOpen: groups instanceof Set ? groups : new Set() });
  }

  setAuthorGroupsTouched(value) {
    this.update({ authorGroupsTouched: Boolean(value) });
  }

  setDropOrigin(origin) {
    const fallback = [0, 0];
    if (!Array.isArray(origin) || origin.length < 2) {
      this.update({ dropOrigin: fallback });
      return;
    }
    const x = Number(origin[0]);
    const y = Number(origin[1]);
    this.update({ dropOrigin: [Number.isFinite(x) ? x : 0, Number.isFinite(y) ? y : 0] });
  }

  setRevisions(revisions, cubeId = null) {
    this.update({
      revisions: Array.isArray(revisions) ? revisions : [],
      revisionsCubeId: cubeId || null,
    });
  }

  setRevisionsLoading(value) {
    this.update({ revisionsLoading: Boolean(value) });
  }

  setSelectedRevision(value) {
    const selectedRevision = typeof value === 'string' && value.trim() ? value.trim() : 'WORKTREE';
    this.update({ selectedRevision });
  }

  setVersionOptions(options) {
    this.update({ versionOptions: Array.isArray(options) ? options : [] });
  }

  setSelectedVersion(value) {
    const selectedVersion = typeof value === 'string' && value.trim() ? value.trim() : '';
    this.update({ selectedVersion });
  }

  setVersionError(message) {
    this.update({ versionError: message || null });
  }

  resetVersionState() {
    this.update({
      versionOptions: [],
      selectedVersion: '',
      versionError: null,
    });
  }
}
