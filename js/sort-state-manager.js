(function () {
  function ensureFirebaseApp() {
    if (!window.firebase) {
      throw new Error('Firebase SDK が読み込まれていません。');
    }

    if (firebase.apps && firebase.apps.length > 0) {
      return;
    }

    const config =
      (typeof firebaseConfig !== 'undefined' && firebaseConfig)
        ? firebaseConfig
        : window.firebaseConfig;

    if (!config) {
      throw new Error('firebaseConfig が見つかりません。js/firebase-config.js の読み込み順または定義を確認してください。');
    }

    firebase.initializeApp(config);
  }

  class SortStateManager {
    constructor(onState, onAuth) {
      ensureFirebaseApp();

      this.onState = onState;
      this.onAuth = onAuth;
      this.db = firebase.firestore();
      this.auth = firebase.auth();
      this.user = null;
      this.sortUnsub = null;
      this.batchUnsub = null;
      this.currentSortState = null;
      this.currentBatch = null;
      this.currentBatchId = null;

      this.auth.onAuthStateChanged((u) => {
        this.user = u;
        this.onAuth && this.onAuth(u);
        this.unsubscribeAll();
        if (!u) {
          this.onState && this.onState(null);
          return;
        }
        this.subscribe();
      });
    }

    ensureAuth() { if (!this.user) throw new Error('未ログインです'); }
    sortDoc() { return this.db.collection('users').doc(this.user.uid).collection('sortState').doc('current'); }
    sortBatches() { return this.db.collection('users').doc(this.user.uid).collection('sortBatches'); }
    batchDoc(batchId) { return this.sortBatches().doc(batchId); }

    unsubscribeAll() {
      if (this.sortUnsub) this.sortUnsub();
      if (this.batchUnsub) this.batchUnsub();
      this.sortUnsub = null;
      this.batchUnsub = null;
      this.currentSortState = null;
      this.currentBatch = null;
      this.currentBatchId = null;
    }

    emitState() {
      this.onState && this.onState({
        sortState: this.currentSortState || {},
        batch: this.currentBatch
      });
    }

    subscribeActiveBatch(batchId) {
      if (this.currentBatchId === batchId) return;
      if (this.batchUnsub) this.batchUnsub();
      this.batchUnsub = null;
      this.currentBatchId = batchId || null;
      this.currentBatch = null;

      if (!batchId) {
        this.emitState();
        return;
      }

      this.batchUnsub = this.batchDoc(batchId).onSnapshot((batchSnap) => {
        this.currentBatch = batchSnap.exists ? { id: batchSnap.id, ...batchSnap.data() } : null;
        this.emitState();
      }, (err) => {
        console.error('activeBatch onSnapshot failed', err);
        this.currentBatch = null;
        this.emitState();
      });
    }

    subscribe() {
      this.sortUnsub = this.sortDoc().onSnapshot((s) => {
        const state = s.exists ? s.data() : {};
        this.currentSortState = state;
        this.subscribeActiveBatch(state?.activeBatchId || null);
        this.emitState();
      });
    }

    async getBatch(batchId) {
      const snap = await this.batchDoc(batchId).get();
      return snap.exists ? { id: snap.id, ...snap.data() } : null;
    }

    async getActiveBatch() {
      this.ensureAuth();
      const stateSnap = await this.sortDoc().get();
      const state = stateSnap.exists ? stateSnap.data() : {};
      if (!state?.activeBatchId) return null;
      return this.getBatch(state.activeBatchId);
    }

    async createBatch(payload) {
      this.ensureAuth();
      // v0.1: 初期想定は約30SKUのため単一ドキュメントで保持。
      // SKU/仕分け先の増加時は items サブコレクション化し、Firestore 1MB制限を回避すること。
      const ref = this.sortBatches().doc();
      await ref.set({
        ...payload,
        status: 'active',
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      await this.sortDoc().set({
        activeBatchId: ref.id,
        activeItemKey: null,
        activeJan: null,
        previousSkuSummary: null,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      return ref.id;
    }

    async setActiveSku(activeItemKey, jan, prev) {
      this.ensureAuth();
      await this.sortDoc().set({
        activeItemKey: activeItemKey || null,
        activeJan: jan || null,
        previousSkuSummary: prev || null,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    async resetAll() {
      this.ensureAuth();
      const snaps = await this.sortBatches().get();
      const b = this.db.batch();
      snaps.forEach((d) => b.delete(d.ref));
      b.delete(this.sortDoc());
      await b.commit();
    }
  }

  window.SortStateManager = SortStateManager;
})();
