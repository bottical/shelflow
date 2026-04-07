// StateManager (Non-module version)
// Depends on firebase-app.js, firebase-auth.js, and firebase-firestore.js (compat versions)

function StateManager(onStateChange, onUserChange) {
    this.onStateChange = onStateChange;
    this.onUserChange = onUserChange;
    this.user = null;
    this.state = null;
    this.unsubscribeState = null;
    this.currentPickList = null;
    this.currentPickListId = null;
    this.unsubscribePickList = null;
    this.currentPickListLoading = false;
    this.currentPickListNotFound = false;
    this.migrationInFlight = false;
    this.migrationCompleted = false;
    this.progressSummaryBackfillInFlight = false;
    this.progressSummaryBackfillCompleted = false;

    if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
    }

    this.auth = firebase.auth();
    this.db = firebase.firestore();

    this.auth.onAuthStateChanged((user) => {
        this.user = user;
        if (this.onUserChange) this.onUserChange(user);

        if (user) {
            this.migrationInFlight = false;
            this.migrationCompleted = false;
            this.progressSummaryBackfillInFlight = false;
            this.progressSummaryBackfillCompleted = false;
            this.subscribeToState(user.uid);
        } else {
            if (this.unsubscribeState) this.unsubscribeState();
            this.clearPickListSubscription();
            this.state = null;
        }
    });

    // Local state for the current session/user
    this.currentUserId = localStorage.getItem('picking_shelf_user_id') || 'user1';
    this.localUiState = {
        injectPendingPreview: null,
        cancelledInjectRequestIds: {},
        optimisticSlots: {},
        optimisticPickCompletions: {},
        optimisticPickLineOps: {},
        transientWallError: null,
        lastOpSeq: 0
    };
}

StateManager.prototype.setCurrentUser = function (userId) {
    this.currentUserId = userId;
    localStorage.setItem('picking_shelf_user_id', userId);
    const currentPickingNo = this.state?.userStates?.[this.currentUserId]?.currentPickingNo || null;
    this.subscribeToPickList(currentPickingNo);
    if (this.state && this.onStateChange) this.onStateChange(this.state);
};

StateManager.prototype._notifyUiOnlyChange = function () {
    if (this.state && this.onStateChange) this.onStateChange(this.state);
};

StateManager.prototype.setLocalInjectPending = function (jan) {
    if (!jan) {
        this.localUiState.injectPendingPreview = null;
    } else if (typeof jan === 'string') {
        this.localUiState.injectPendingPreview = {
            jan,
            status: 'WAITING_SLOT',
            requestedAt: Date.now(),
            requestId: this.createInjectRequestId()
        };
    } else {
        this.localUiState.injectPendingPreview = {
            jan: jan.jan,
            status: jan.status || 'WAITING_SLOT',
            requestedAt: jan.requestedAt || Date.now(),
            requestId: jan.requestId || this.createInjectRequestId()
        };
    }
    this._notifyUiOnlyChange();
};

StateManager.prototype.clearLocalInjectPending = function () {
    this.localUiState.injectPendingPreview = null;
    this._notifyUiOnlyChange();
};

StateManager.prototype.isInjectRequestCancelled = function (requestId) {
    if (!requestId) return false;
    return !!(this.localUiState.cancelledInjectRequestIds && this.localUiState.cancelledInjectRequestIds[requestId]);
};

StateManager.prototype.getEffectiveInjectPendingForCurrentUser = function (state) {
    const targetState = state || this.state || {};
    const currentUserState = targetState.userStates?.[this.currentUserId] || {};

    const remotePending = currentUserState.injectPending || null;
    const remoteCancelled = currentUserState.injectPendingCancelled || null;
    const localPending = this.localUiState.injectPendingPreview || null;

    const remoteRequestId = remotePending?.requestId || null;
    const remoteCancelledLocally = this.isInjectRequestCancelled(remoteRequestId);
    const remoteCancelledRemotely =
        !!remotePending &&
        !!remoteCancelled &&
        !!remoteCancelled.requestId &&
        remoteCancelled.requestId === remoteRequestId;

    if (remotePending && !remoteCancelledLocally && !remoteCancelledRemotely) {
        return remotePending;
    }

    return localPending || null;
};

StateManager.prototype.hasEffectiveInjectPendingForCurrentUser = function (state) {
    return !!this.getEffectiveInjectPendingForCurrentUser(state);
};

StateManager.prototype.getInProgressWorkForCurrentUser = function (state) {
    const targetState = state || this.state || {};
    const currentUserState = targetState.userStates?.[this.currentUserId] || {};
    const injectPending = this.getEffectiveInjectPendingForCurrentUser(targetState);
    const currentPickingNo = currentUserState.currentPickingNo || null;
    const activePick = currentUserState.activePick || {};
    const hasPickEntries = Object.values(activePick).some((entry) => {
        if (!entry || typeof entry !== 'object') return false;
        if (typeof entry.pendingQty === 'number') return entry.pendingQty > 0;
        return true;
    });

    return {
        hasInjectInProgress: !!injectPending,
        injectPending,
        hasPickInProgress: !!currentPickingNo && hasPickEntries,
        currentPickingNo,
        activePick
    };
};

StateManager.prototype.cancelCurrentWorkForNavigation = async function () {
    const work = this.getInProgressWorkForCurrentUser(this.state);
    if (work.hasInjectInProgress) {
        await this.cancelInjectPending();
    }
    if (work.hasPickInProgress) {
        await this.resetUserPick(this.currentUserId);
    }
    return work;
};

StateManager.prototype.getActiveDuplicateHighlightForUser = function (state, userId) {
    const targetState = state || this.state || {};
    const targetUserId = userId || this.currentUserId;
    const duplicateHighlight = targetState.userStates?.[targetUserId]?.duplicateHighlight || null;
    const slotKey = duplicateHighlight?.slotKey || null;
    if (!slotKey) return null;
    return duplicateHighlight;
};

StateManager.prototype.triggerDuplicateHighlight = function (slotKey, jan) {
    if (!this.user) return Promise.reject("Not authenticated");
    if (!slotKey) return Promise.resolve();
    const uid = this.user.uid;
    const currentUserId = this.currentUserId;
    return this.update({
        [`userStates.${currentUserId}.duplicateHighlight`]: {
            slotKey,
            jan: jan || null,
            highlightedAt: Date.now()
        }
    }).catch((error) => {
        this._logFirestoreError('triggerDuplicateHighlight', error, uid);
        throw error;
    });
};

StateManager.prototype.clearDuplicateHighlight = function (options = {}) {
    if (!this.user) return Promise.reject("Not authenticated");
    const uid = this.user.uid;
    const currentUserId = this.currentUserId;
    const compareSlotKey = options?.slotKey || null;
    const compareJan = options?.jan || null;

    if (!compareSlotKey && !compareJan) {
        return this.update({
            [`userStates.${currentUserId}.duplicateHighlight`]: null
        }).catch((error) => {
            this._logFirestoreError('clearDuplicateHighlight', error, uid);
            throw error;
        });
    }

    const duplicateHighlight = this.state?.userStates?.[currentUserId]?.duplicateHighlight || null;
    const slotMatches = !compareSlotKey || duplicateHighlight?.slotKey === compareSlotKey;
    const janMatches = !compareJan || duplicateHighlight?.jan === compareJan;
    if (!slotMatches || !janMatches) return Promise.resolve({ skipped: true });

    return this.update({
        [`userStates.${currentUserId}.duplicateHighlight`]: null
    }).catch((error) => {
        this._logFirestoreError('clearDuplicateHighlight', error, uid);
        throw error;
    });
};

StateManager.prototype.cancelInjectPending = function () {
    if (!this.user) return Promise.reject("Not authenticated");
    const uid = this.user.uid;
    const docRef = this._getStateDocRef(uid);
    const currentUserId = this.currentUserId;
    const localPending = this.localUiState.injectPendingPreview || null;

    return this.db.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        const data = doc.exists ? (doc.data() || {}) : {};
        const currentUserState = data.userStates?.[currentUserId] || {};
        const remotePending = currentUserState.injectPending || null;
        const remoteCancelled = currentUserState.injectPendingCancelled || null;
        const pending = remotePending || localPending;
        const requestId = pending?.requestId || null;
        const cancelledAt = Date.now();

        console.debug('[inject-cancel] transaction compare-and-set', {
            currentUserId,
            requestId,
            remotePendingRequestId: remotePending?.requestId || null,
            remoteCancelledRequestId: remoteCancelled?.requestId || null
        });

        const updates = {
            [`userStates.${currentUserId}.injectPending`]: null,
            [`userStates.${currentUserId}.duplicateHighlight`]: null
        };

        if (!pending) {
            updates[`userStates.${currentUserId}.injectPendingCancelled`] = null;
            transaction.update(docRef, updates);
            return { requestId: null, jan: null, cancelledAt: null };
        }

        updates[`userStates.${currentUserId}.injectPendingCancelled`] = {
            requestId,
            jan: pending?.jan || null,
            cancelledAt
        };
        transaction.update(docRef, updates);
        return { requestId, jan: pending?.jan || null, cancelledAt };
    }).then((result) => {
        const requestId = result?.requestId || null;
        if (requestId) {
            this.localUiState.cancelledInjectRequestIds[requestId] = {
                jan: result?.jan || null,
                cancelledAt: result?.cancelledAt || Date.now()
            };
        }
        this.clearLocalInjectPending();
        return result;
    }).catch((error) => {
        this._logFirestoreError('cancelInjectPending', error, uid);
        throw error;
    });
};

StateManager.prototype.createInjectRequestId = function () {
    return `inject-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

StateManager.prototype.createPickCompletionOpId = function () {
    return `pick-complete-op-${Date.now()}-${++this.localUiState.lastOpSeq}`;
};

StateManager.prototype.createPickLineOpId = function () {
    return `pick-line-op-${Date.now()}-${++this.localUiState.lastOpSeq}`;
};

StateManager.prototype.setOptimisticPickCompletion = function (slotKey, listId) {
    if (!slotKey || !listId) return null;
    const active = this.localUiState.optimisticPickCompletions?.[slotKey];
    if (
        active &&
        String(active.listId) === String(listId) &&
        Date.now() - (active.createdAt || 0) < 1200
    ) {
        return active.opId;
    }
    const opId = this.createPickCompletionOpId();
    this.localUiState.optimisticPickCompletions[slotKey] = {
        opId,
        listId: String(listId),
        createdAt: Date.now(),
        status: 'pending'
    };
    this._notifyUiOnlyChange();
    return opId;
};

StateManager.prototype.markOptimisticPickCompletionCommitted = function (slotKey, opId) {
    if (!slotKey) return;
    const completion = this.localUiState.optimisticPickCompletions?.[slotKey];
    if (!completion) return;
    if (opId && completion.opId !== opId) return;
    completion.status = 'committed';
    completion.committedAt = Date.now();
    this._notifyUiOnlyChange();
};

StateManager.prototype.clearOptimisticPickCompletion = function (slotKey, opId) {
    if (!slotKey) return;
    const completion = this.localUiState.optimisticPickCompletions?.[slotKey];
    if (!completion) return;
    if (opId && completion.opId !== opId) return;
    delete this.localUiState.optimisticPickCompletions[slotKey];
    this._notifyUiOnlyChange();
};

StateManager.prototype.clearOptimisticPickCompletions = function (listId = null) {
    const completions = this.localUiState.optimisticPickCompletions || {};
    const allKeys = Object.keys(completions);
    if (!allKeys.length) return;

    let changed = false;
    allKeys.forEach((slotKey) => {
        if (listId && String(completions[slotKey]?.listId) !== String(listId)) return;
        delete completions[slotKey];
        changed = true;
    });

    if (changed) this._notifyUiOnlyChange();
};

StateManager.prototype.setOptimisticPickLine = function (listId, index, nextLine) {
    if (!listId || index === null || index === undefined || !nextLine) return null;
    const normalizedListId = String(listId);
    const normalizedIndex = String(index);
    if (!this.localUiState.optimisticPickLineOps[normalizedListId]) {
        this.localUiState.optimisticPickLineOps[normalizedListId] = {};
    }
    const opId = this.createPickLineOpId();
    this.localUiState.optimisticPickLineOps[normalizedListId][normalizedIndex] = {
        opId,
        checkedQty: this._toSafeCheckedQty(nextLine, nextLine?.qty),
        status: nextLine?.status === 'DONE' ? 'DONE' : (nextLine?.status === 'PARTIAL' ? 'PARTIAL' : 'PENDING'),
        createdAt: Date.now(),
        result: 'pending'
    };
    this._notifyUiOnlyChange();
    return opId;
};

StateManager.prototype.markOptimisticPickLineCommitted = function (listId, index, opId) {
    if (!listId || index === null || index === undefined) return;
    const op = this.localUiState.optimisticPickLineOps?.[String(listId)]?.[String(index)];
    if (!op) return;
    if (opId && op.opId !== opId) return;
    op.result = 'committed';
    op.committedAt = Date.now();
    this._notifyUiOnlyChange();
};

StateManager.prototype.clearOptimisticPickLine = function (listId, index, opId) {
    if (!listId || index === null || index === undefined) return;
    const normalizedListId = String(listId);
    const normalizedIndex = String(index);
    const listOps = this.localUiState.optimisticPickLineOps?.[normalizedListId];
    const op = listOps?.[normalizedIndex];
    if (!op) return;
    if (opId && op.opId !== opId) return;
    delete listOps[normalizedIndex];
    if (!Object.keys(listOps).length) {
        delete this.localUiState.optimisticPickLineOps[normalizedListId];
    }
    this._notifyUiOnlyChange();
};

StateManager.prototype.clearOptimisticPickLines = function (listId = null) {
    if (listId === null || listId === undefined) {
        if (!Object.keys(this.localUiState.optimisticPickLineOps || {}).length) return;
        this.localUiState.optimisticPickLineOps = {};
        this._notifyUiOnlyChange();
        return;
    }
    const normalizedListId = String(listId);
    if (!this.localUiState.optimisticPickLineOps?.[normalizedListId]) return;
    delete this.localUiState.optimisticPickLineOps[normalizedListId];
    this._notifyUiOnlyChange();
};

StateManager.prototype.getMergedPickLines = function (listId, remoteLines) {
    const normalizedRemoteLines = this._normalizePickLines(Array.isArray(remoteLines) ? remoteLines : []);
    if (!listId) return normalizedRemoteLines;
    const listOps = this.localUiState.optimisticPickLineOps?.[String(listId)] || {};
    if (!Object.keys(listOps).length) return normalizedRemoteLines;
    return normalizedRemoteLines.map((line, idx) => {
        const op = listOps[String(idx)];
        if (!op) return line;
        const qty = this._toSafeQty(line?.qty);
        const checkedQty = this._toSafeCheckedQty({ ...line, checkedQty: op.checkedQty }, qty);
        const status = checkedQty >= qty ? 'DONE' : (checkedQty > 0 ? 'PARTIAL' : 'PENDING');
        return {
            ...line,
            checkedQty,
            status
        };
    });
};

StateManager.prototype.isOptimisticPickCompletionActive = function (slotKey, state) {
    if (!slotKey) return false;
    const completion = this.localUiState.optimisticPickCompletions?.[slotKey];
    if (!completion) return false;
    const targetState = state || this.state || {};
    const currentUserState = targetState.userStates?.[this.currentUserId] || {};
    const currentPickingNo = currentUserState.currentPickingNo || null;
    if (!currentPickingNo) return false;
    return String(completion.listId) === String(currentPickingNo);
};

StateManager.prototype.setTransientWallError = function (slotKey, message, ttlMs = 3200) {
    this.localUiState.transientWallError = {
        slotKey: slotKey || null,
        message: message || '通信失敗。もう一度タップしてください',
        at: Date.now(),
        expiresAt: Date.now() + ttlMs
    };
    this._notifyUiOnlyChange();
};

StateManager.prototype.clearTransientWallError = function (slotKey) {
    const current = this.localUiState.transientWallError;
    if (!current) return;
    if (slotKey && current.slotKey && current.slotKey !== slotKey) return;
    this.localUiState.transientWallError = null;
    this._notifyUiOnlyChange();
};

StateManager.prototype.getTransientWallError = function () {
    const current = this.localUiState.transientWallError;
    if (!current) return null;
    if (current.expiresAt && Date.now() > current.expiresAt) {
        this.localUiState.transientWallError = null;
        this._notifyUiOnlyChange();
        return null;
    }
    return current;
};

StateManager.prototype.setOptimisticSlot = function (slotKey, jan) {
    if (!slotKey || !jan) return;
    const opId = `inject-op-${Date.now()}-${++this.localUiState.lastOpSeq}`;
    const currentSlots = this.state?.slots || {};
    const previousSlotData = currentSlots[slotKey]
        ? { skus: [...(currentSlots[slotKey].skus || (currentSlots[slotKey].sku ? [currentSlots[slotKey].sku] : []))] }
        : null;

    const nextSkus = previousSlotData ? [...previousSlotData.skus] : [];
    if (!nextSkus.includes(jan)) {
        nextSkus.push(jan);
    }

    this.localUiState.optimisticSlots[slotKey] = {
        skus: nextSkus,
        _meta: {
            opId,
            status: 'pending',
            createdAt: Date.now(),
            jan,
            previousSlotData
        }
    };
    this._notifyUiOnlyChange();
    return opId;
};

StateManager.prototype.markOptimisticSlotCommitted = function (slotKey, opId) {
    const slot = this.localUiState.optimisticSlots[slotKey];
    if (!slot || !slot._meta) return;
    if (opId && slot._meta.opId !== opId) return;
    slot._meta.status = 'committed';
    slot._meta.committedAt = Date.now();
    this._notifyUiOnlyChange();
};

StateManager.prototype.clearOptimisticSlot = function (slotKey, opId) {
    if (!slotKey) return;
    const slot = this.localUiState.optimisticSlots[slotKey];
    if (opId && slot?._meta?.opId !== opId) return;
    delete this.localUiState.optimisticSlots[slotKey];
    this._notifyUiOnlyChange();
};

StateManager.prototype.rollbackOptimisticInject = function (opId) {
    this.localUiState.injectPendingPreview = null;
    if (!opId) {
        this.localUiState.optimisticSlots = {};
    } else {
        Object.keys(this.localUiState.optimisticSlots || {}).forEach((slotKey) => {
            const slot = this.localUiState.optimisticSlots[slotKey];
            if (slot?._meta?.opId === opId) {
                delete this.localUiState.optimisticSlots[slotKey];
            }
        });
    }
    this._notifyUiOnlyChange();
};

StateManager.prototype._reconcileLocalUiStateWithRemote = function (remoteState) {
    const remoteSlots = remoteState?.slots || {};
    const optimisticSlots = this.localUiState.optimisticSlots || {};
    const optimisticPickCompletions = this.localUiState.optimisticPickCompletions || {};
    const optimisticPickLineOps = this.localUiState.optimisticPickLineOps || {};
    const remoteUserPending = remoteState?.userStates?.[this.currentUserId]?.injectPending;
    const remoteActivePick = remoteState?.userStates?.[this.currentUserId]?.activePick || {};
    const remotePickingNo = remoteState?.userStates?.[this.currentUserId]?.currentPickingNo || null;
    const remoteCancelledInfo = remoteState?.userStates?.[this.currentUserId]?.injectPendingCancelled || null;
    const remotePendingRequestId = remoteUserPending?.requestId || null;
    const remotePendingCancelledLocally = this.isInjectRequestCancelled(remotePendingRequestId);
    const remotePendingCancelledRemotely =
        !!remotePendingRequestId &&
        remoteCancelledInfo?.requestId === remotePendingRequestId;
    const remotePendingCancelled = remotePendingCancelledLocally || remotePendingCancelledRemotely;
    let changed = false;

    Object.keys(optimisticSlots).forEach((slotKey) => {
        const slot = optimisticSlots[slotKey];
        const jan = slot?._meta?.jan;
        if (!jan) return;
        const status = slot?._meta?.status || 'pending';

        const remoteSkus = remoteSlots[slotKey]?.skus || (remoteSlots[slotKey]?.sku ? [remoteSlots[slotKey].sku] : []);
        const hasRemoteCommit = remoteSkus.includes(jan);
        const effectiveRemotePending = remotePendingCancelled ? null : remoteUserPending;
        const isPendingClearedForThisJan = !effectiveRemotePending || effectiveRemotePending.jan !== jan;
        const remoteConfirmed = hasRemoteCommit && isPendingClearedForThisJan;

        const committedAt = slot?._meta?.committedAt || 0;
        const createdAt = slot?._meta?.createdAt || 0;
        const now = Date.now();
        const committedTtlExpired = status === 'committed' && committedAt > 0 && (now - committedAt > 12000);
        const pendingTtlExpired = status === 'pending' && createdAt > 0 && (now - createdAt > 25000);

        if (remoteConfirmed || committedTtlExpired || pendingTtlExpired) {
            delete optimisticSlots[slotKey];
            changed = true;
        }
    });

    Object.keys(optimisticPickCompletions).forEach((slotKey) => {
        const optimisticPick = optimisticPickCompletions[slotKey];
        if (!optimisticPick) return;
        const now = Date.now();
        const createdAt = optimisticPick.createdAt || 0;
        const committedAt = optimisticPick.committedAt || 0;
        const isPending = (optimisticPick.status || 'pending') === 'pending';
        const expectedListId = optimisticPick.listId || null;
        const activeEntry = remoteActivePick?.[slotKey];
        const remotePendingQty = activeEntry?.pendingQty;
        const remoteTotalQty = activeEntry?.totalQty;

        const remoteDoneForSlot = activeEntry && remotePendingQty === 0 && remoteTotalQty > 0;
        const remoteClearedForSlot =
            !activeEntry &&
            expectedListId &&
            remotePickingNo &&
            String(expectedListId) === String(remotePickingNo);
        const pendingTtlExpired = isPending && createdAt > 0 && (now - createdAt > 10000);
        const committedTtlExpired = !isPending && committedAt > 0 && (now - committedAt > 12000);

        if (remoteDoneForSlot || remoteClearedForSlot || pendingTtlExpired || committedTtlExpired) {
            delete optimisticPickCompletions[slotKey];
            changed = true;
        }
    });

    Object.keys(optimisticPickLineOps).forEach((listId) => {
        if (!remotePickingNo || String(listId) !== String(remotePickingNo)) {
            delete optimisticPickLineOps[listId];
            changed = true;
            return;
        }
        const remoteLines = this.currentPickListId === String(listId)
            ? (this.currentPickList?.lines || [])
            : [];
        const listOps = optimisticPickLineOps[listId] || {};
        Object.keys(listOps).forEach((lineIndex) => {
            const op = listOps[lineIndex];
            if (!op) return;
            const now = Date.now();
            const createdAt = op.createdAt || 0;
            const committedAt = op.committedAt || 0;
            const remoteLine = remoteLines[Number(lineIndex)];
            const remoteQty = this._toSafeQty(remoteLine?.qty);
            const remoteCheckedQty = this._toSafeCheckedQty(remoteLine, remoteQty);
            const remoteStatus = remoteCheckedQty >= remoteQty ? 'DONE' : (remoteCheckedQty > 0 ? 'PARTIAL' : 'PENDING');
            const optimisticQty = this._toSafeCheckedQty({ checkedQty: op.checkedQty, status: op.status }, remoteQty);
            const remoteCaughtUp = remoteLine && remoteCheckedQty >= optimisticQty && (
                remoteStatus === 'DONE' ||
                remoteStatus === op.status ||
                (op.status === 'PARTIAL' && remoteStatus === 'DONE')
            );
            const committedTtlExpired = committedAt > 0 && (now - committedAt > 12000);
            const createdTtlExpired = createdAt > 0 && (now - createdAt > 25000);
            if (remoteCaughtUp || committedTtlExpired || createdTtlExpired) {
                delete listOps[lineIndex];
                changed = true;
            }
        });
        if (!Object.keys(listOps).length) {
            delete optimisticPickLineOps[listId];
            changed = true;
        }
    });

    const localPending = this.localUiState.injectPendingPreview;
    if (localPending) {
        const remotePending = remotePendingCancelled
            ? null
            : (remoteState?.userStates?.[this.currentUserId]?.injectPending || null);
        const localJan = localPending.jan;
        const localRequestId = localPending.requestId || null;

        const sameRemotePending =
            remotePending &&
            remotePending.jan === localJan &&
            (!localRequestId || remotePending.requestId === localRequestId);

        const janExistsSomewhere = Object.values(remoteSlots).some((slot) => {
            const skus = slot?.skus || (slot?.sku ? [slot.sku] : []);
            return skus.includes(localJan);
        });

        if (!sameRemotePending && janExistsSomewhere) {
            this.localUiState.injectPendingPreview = null;
            changed = true;
        }

        if (remotePendingCancelled && (!localRequestId || localRequestId === remotePendingRequestId)) {
            this.localUiState.injectPendingPreview = null;
            changed = true;
        }
    } else if (remotePendingCancelled) {
        changed = true;
    }

    // NOTE:
    // Remote injectPendingCancelled cleanup (nulling stale values in Firestore) is intentionally
    // deferred to keep this patch minimal and avoid extra write chatter from reconcile loops.

    const cancelledMap = this.localUiState.cancelledInjectRequestIds || {};
    Object.keys(cancelledMap).forEach((reqId) => {
        const info = cancelledMap[reqId] || {};
        const cancelledAt = info.cancelledAt || 0;
        const jan = info.jan || null;
        const stillPendingRemotely = remotePendingRequestId === reqId;
        const janExistsSomewhere = jan && Object.values(remoteSlots).some((slot) => {
            const skus = slot?.skus || (slot?.sku ? [slot.sku] : []);
            return skus.includes(jan);
        });
        const expired = Date.now() - cancelledAt > 15000;
        if (expired || !stillPendingRemotely || janExistsSomewhere) {
            delete cancelledMap[reqId];
            changed = true;
        }
    });

    const transientWallError = this.localUiState.transientWallError;
    if (transientWallError?.expiresAt && Date.now() > transientWallError.expiresAt) {
        this.localUiState.transientWallError = null;
        changed = true;
    }

    if (changed) {
        this._notifyUiOnlyChange();
    }
};

StateManager.prototype._getStateDocRef = function (uid) {
    const resolvedUid = uid || this.user?.uid;
    return this.db.collection("users").doc(resolvedUid).collection("states").doc("current");
};

StateManager.prototype._getStateDocPath = function (uid) {
    const resolvedUid = uid || this.user?.uid || 'unknown';
    return `users/${resolvedUid}/states/current`;
};

StateManager.prototype._getPickListCollectionRef = function (uid) {
    const resolvedUid = uid || this.user?.uid;
    return this.db.collection("users").doc(resolvedUid).collection("pickLists");
};

StateManager.prototype._getPickListDocRef = function (uid, listId) {
    return this._getPickListCollectionRef(uid).doc(String(listId));
};

StateManager.prototype._logFirestoreError = function (action, error, uid) {
    console.error(`[firestore:${action}] failed`, {
        uid: uid || this.user?.uid,
        currentUserId: this.currentUserId,
        path: this._getStateDocPath(uid),
        code: error?.code,
        message: error?.message,
        error
    });
};

StateManager.prototype.subscribeToState = function (uid) {
    if (this.unsubscribeState) this.unsubscribeState();

    const docRef = this._getStateDocRef(uid);

    this.unsubscribeState = docRef.onSnapshot((doc) => {
        if (doc.exists) {
            const data = doc.data();
            this._migrateLegacyPickListsIfNeeded(uid, data);
            this._backfillProgressSummaryIfNeeded(uid, data);
            // Migrate old state if needed
            if (!data.userStates) {
                this.migrateToMultiUser(uid, data);
            } else {
                this.state = data;
                const currentPickingNo = data.userStates?.[this.currentUserId]?.currentPickingNo || null;
                if (this.currentPickListId !== currentPickingNo) {
                    this.subscribeToPickList(currentPickingNo);
                }
                this._reconcileLocalUiStateWithRemote(data);
                if (this.onStateChange) this.onStateChange(this.state);
            }
        } else {
            this.initializeNewSession(uid);
        }
    }, (error) => {
        this._logFirestoreError('subscribeToState', error, uid);
    });
};

StateManager.prototype._backfillProgressSummaryIfNeeded = function (uid, data) {
    if (this.progressSummaryBackfillCompleted || this.progressSummaryBackfillInFlight) return;
    const hasProgressSummary =
        !!data?.progressSummary &&
        Number.isFinite(Number(data.progressSummary.total)) &&
        Number.isFinite(Number(data.progressSummary.completed));
    if (hasProgressSummary) {
        this.progressSummaryBackfillCompleted = true;
        return;
    }
    if (data?.pickLists) return;

    this.progressSummaryBackfillInFlight = true;
    this._getPickListCollectionRef(uid).get().then((snapshot) => {
        let total = 0;
        let completed = 0;
        snapshot.forEach((doc) => {
            total += 1;
            if (this._isPickListCompleted(doc.data()?.lines || [])) completed += 1;
        });
        return this._getStateDocRef(uid).update({
            progressSummary: { total, completed },
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    }).then(() => {
        this.progressSummaryBackfillCompleted = true;
    }).catch((error) => {
        this._logFirestoreError('_backfillProgressSummaryIfNeeded', error, uid);
    }).finally(() => {
        this.progressSummaryBackfillInFlight = false;
    });
};

StateManager.prototype.subscribeToPickList = function (listId) {
    if (!this.user) return;
    const normalizedListId = listId ? String(listId) : null;
    if (!normalizedListId) {
        this.clearPickListSubscription();
        return;
    }
    if (this.currentPickListId === normalizedListId && this.unsubscribePickList) return;
    this.clearPickListSubscription();

    this.currentPickListId = normalizedListId;
    this.currentPickListLoading = true;
    this.currentPickListNotFound = false;
    const docRef = this._getPickListDocRef(this.user.uid, normalizedListId);
    this.unsubscribePickList = docRef.onSnapshot((doc) => {
        if (!doc.exists) {
            this.currentPickList = null;
        } else {
            const data = doc.data() || {};
            this.currentPickList = {
                ...data,
                lines: this._normalizePickLines(data.lines || [])
            };
        }
        this.currentPickListLoading = false;
        this.currentPickListNotFound = !doc.exists;
        this._notifyUiOnlyChange();
    }, (error) => {
        this.currentPickListLoading = false;
        console.error('[firestore:subscribeToPickList] failed', error);
    });
};

StateManager.prototype.clearPickListSubscription = function () {
    const oldListId = this.currentPickListId;
    if (this.unsubscribePickList) this.unsubscribePickList();
    this.unsubscribePickList = null;
    this.currentPickList = null;
    this.currentPickListId = null;
    this.currentPickListLoading = false;
    this.currentPickListNotFound = false;
    if (oldListId) this.clearOptimisticPickLines(oldListId);
};

StateManager.prototype.migrateToMultiUser = function (uid, oldData) {
    const userStates = {
        user1: {
            activePick: oldData.activePick || {},
            currentPickingNo: oldData.currentPickingNo || null,
            injectPending: oldData.injectPending || null,
            duplicateHighlight: null
        },
        user2: { activePick: {}, currentPickingNo: null, injectPending: null, duplicateHighlight: null },
        user3: { activePick: {}, currentPickingNo: null, injectPending: null, duplicateHighlight: null },
        user4: { activePick: {}, currentPickingNo: null, injectPending: null, duplicateHighlight: null }
    };
    
    const updates = {
        userStates: userStates,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    // Clean up old root fields
    updates.activePick = firebase.firestore.FieldValue.delete();
    updates.currentPickingNo = firebase.firestore.FieldValue.delete();
    updates.injectPending = firebase.firestore.FieldValue.delete();

    return this._getStateDocRef(uid).update(updates).catch((error) => {
        this._logFirestoreError('migrateToMultiUser', error, uid);
        throw error;
    });
};

StateManager.prototype._buildJanIndexFromSlots = function (slots) {
    const janIndex = {};
    Object.entries(slots || {}).forEach(([slotKey, slot]) => {
        const skus = slot?.skus || (slot?.sku ? [slot.sku] : []);
        skus.forEach((jan) => {
            if (jan) janIndex[String(jan)] = slotKey;
        });
    });
    return janIndex;
};

StateManager.prototype.normalizeJanValue = function (jan) {
    if (!jan) return "";
    let s = String(jan);
    s = s.replace(/[０-９]/g, (v) => String.fromCharCode(v.charCodeAt(0) - 0xFEE0));
    s = s.replace(/[\u0000-\u001F\u007F]/g, '');
    s = s.replace(/\s+/g, '');
    s = s.trim();
    return s;
};

StateManager.prototype._migrateLegacyPickListsIfNeeded = function (uid, data) {
    if (this.migrationCompleted || this.migrationInFlight) return;
    const legacyPickLists = data?.pickLists;
    const needsJanIndex = !data?.janIndex;
    if (!legacyPickLists && !needsJanIndex) return;
    this.migrationInFlight = true;

    const docRef = this._getStateDocRef(uid);
    const updates = {
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    const entries = Object.entries(legacyPickLists || {});

    this._writePickListEntriesInChunks(uid, entries).then(async () => {
        if (legacyPickLists) updates.pickLists = firebase.firestore.FieldValue.delete();
        if (needsJanIndex) {
            updates.janIndex = this._buildJanIndexFromSlots(data?.slots || {});
        }
        await docRef.update(updates);
        this.migrationCompleted = true;
    }).catch((error) => {
        this._logFirestoreError('_migrateLegacyPickListsIfNeeded', error, uid);
    }).finally(() => {
        this.migrationInFlight = false;
    });
};

StateManager.prototype.initializeNewSession = function (uid) {
    const defaultConfig = {
        bays: null,
        maxSplit: 6,
        viewMode: 'multi',
        orientation: 'landscape',
        multiRows: 3,
        multiCols: 3,
        showOthers: false,
        pickMode: 'NORMAL',
        quantityVerification: false
    };

    const sourceConfig = this.state?.config || {};
    const { multiStartId: _legacyMultiStartId, ...sourceConfigWithoutLegacy } = sourceConfig;
    const config = {
        ...defaultConfig,
        ...sourceConfigWithoutLegacy
    };

    const totalBays = config.bays || 0;
    const splits = {};
    for (let b = 1; b <= totalBays; b++) {
        splits[b] = this.state?.splits?.[b] || 1;
    }

    const initialState = {
        mode: 'INJECT',
        config,
        slots: {},
        splits,
        injectList: {},
        janIndex: {},
        userStates: {
            user1: { activePick: {}, currentPickingNo: null, injectPending: null, duplicateHighlight: null },
            user2: { activePick: {}, currentPickingNo: null, injectPending: null, duplicateHighlight: null },
            user3: { activePick: {}, currentPickingNo: null, injectPending: null, duplicateHighlight: null },
            user4: { activePick: {}, currentPickingNo: null, injectPending: null, duplicateHighlight: null }
        },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    return this._getStateDocRef(uid).set(initialState).catch((error) => {
        this._logFirestoreError('initializeNewSession', error, uid);
        throw error;
    });
};

StateManager.prototype.update = function (updates) {
    if (!this.user) return Promise.reject("Not authenticated");
    const uid = this.user.uid;
    const docRef = this._getStateDocRef(uid);
    const payload = {
        ...updates,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    return docRef.update(payload).catch(async (error) => {
        const isNotFound =
            error?.code === 'not-found' ||
            /No document to update/i.test(error?.message || '');
        if (isNotFound) {
            await docRef.set(payload, { merge: true });
            return;
        }
        this._logFirestoreError('update', error, uid);
        throw error;
    });
};

StateManager.prototype._getBatchChunkSize = function () {
    return 450;
};

StateManager.prototype._writePickListEntriesInChunks = async function (uid, entries) {
    if (!entries || entries.length === 0) return;
    const chunkSize = this._getBatchChunkSize();
    for (let i = 0; i < entries.length; i += chunkSize) {
        const chunk = entries.slice(i, i + chunkSize);
        const batch = this.db.batch();
        chunk.forEach(([listId, lines]) => {
            batch.set(this._getPickListDocRef(uid, listId), {
                lines: this._normalizePickLines(Array.isArray(lines) ? lines : []),
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        });
        await batch.commit();
    }
};

StateManager.prototype._deleteAllPickListDocs = async function (uid) {
    const chunkSize = this._getBatchChunkSize();
    while (true) {
        const snapshot = await this._getPickListCollectionRef(uid).limit(chunkSize).get();
        if (snapshot.empty) break;
        const batch = this.db.batch();
        snapshot.docs.forEach((doc) => batch.delete(doc.ref));
        await batch.commit();
        if (snapshot.size < chunkSize) break;
    }
};

StateManager.prototype.replaceAllPickLists = async function (groupedPick) {
    if (!this.user) return Promise.reject("Not authenticated");
    const uid = this.user.uid;
    await this._deleteAllPickListDocs(uid);
    const entries = Object.entries(groupedPick || {});
    await this._writePickListEntriesInChunks(uid, entries);
};

StateManager.prototype.loadPickList = async function (listId) {
    if (!this.user || !listId) return null;
    this.currentPickListLoading = true;
    this.currentPickListNotFound = false;
    const doc = await this._getPickListDocRef(this.user.uid, listId).get();
    if (!doc.exists) {
        this.currentPickList = null;
        this.currentPickListId = null;
        this.currentPickListLoading = false;
        this.currentPickListNotFound = true;
        return null;
    }
    const rawData = doc.data() || null;
    const pickListData = rawData ? {
        ...rawData,
        lines: this._normalizePickLines(rawData.lines || [])
    } : null;
    this.currentPickList = pickListData;
    this.currentPickListLoading = false;
    this.currentPickListNotFound = false;
    this.subscribeToPickList(listId);
    return pickListData;
};

StateManager.prototype._normalizePickLines = function (lines) {
    return (lines || []).map((line) => {
        const qty = this._toSafeQty(line?.qty);
        const checkedQty = this._toSafeCheckedQty(line, qty);
        const status = checkedQty >= qty ? 'DONE' : (checkedQty > 0 ? 'PARTIAL' : 'PENDING');
        return {
            ...line,
            qty,
            checkedQty,
            status
        };
    });
};

StateManager.prototype.getPickListProgressSummary = async function () {
    if (!this.user) return { total: 0, completed: 0 };
    const snapshot = await this._getPickListCollectionRef(this.user.uid).get();
    let total = 0;
    let completed = 0;

    snapshot.forEach((doc) => {
        total += 1;
        const lines = this._normalizePickLines(doc.data()?.lines || []);
        const allDone = lines.length > 0 && lines.every((line) => this._isLineCompleted(line));
        if (allDone) completed += 1;
    });

    return { total, completed };
};

StateManager.prototype._hasActiveSkuInSlot = function (slotData) {
    return !!slotData && (
        (Array.isArray(slotData.skus) && slotData.skus.length > 0) ||
        !!slotData.sku
    );
};

StateManager.prototype.applyBulkSplitCount = function (targetSplit) {
    if (!this.user || !this.state) return Promise.reject("Not authenticated");
    const uid = this.user.uid;

    const normalizedTarget = Math.max(1, Math.min(6, parseInt(targetSplit, 10) || 1));

    return this.db.runTransaction(async (transaction) => {
        const docRef = this._getStateDocRef(uid);
        const doc = await transaction.get(docRef);
        if (!doc.exists) return { changedBays: 0, constrainedBays: 0, targetSplit: normalizedTarget };

        const data = doc.data() || {};
        const totalBays = parseInt(data.config?.bays, 10) || 0;
        const splits = data.splits || {};
        const slots = data.slots || {};
        const updates = {
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        let changedBays = 0;
        let constrainedBays = 0;

        for (let bay = 1; bay <= totalBays; bay++) {
            const originalSplit = parseInt(splits[bay], 10) || 1;
            let nextSplit = originalSplit;

            if (nextSplit < normalizedTarget) {
                nextSplit = normalizedTarget;
            } else if (nextSplit > normalizedTarget) {
                let constrained = false;
                while (nextSplit > normalizedTarget) {
                    const lastSlotKey = `${bay}-${nextSplit}`;
                    if (this._hasActiveSkuInSlot(slots[lastSlotKey])) {
                        constrained = true;
                        break;
                    }
                    nextSplit -= 1;
                }
                if (constrained) constrainedBays += 1;
            }

            if (originalSplit !== nextSplit) {
                updates[`splits.${bay}`] = nextSplit;
                changedBays += 1;
            }
        }

        transaction.update(docRef, updates);
        return { changedBays, constrainedBays, targetSplit: normalizedTarget };
    }).catch((error) => {
        this._logFirestoreError('applyBulkSplitCount', error, uid);
        throw error;
    });
};

StateManager.prototype._applyResetLogic = async function (userId, uid, data, updates, transaction) {
    const userState = data.userStates?.[userId];
    if (!userState) return;

    const oldListId = userState.currentPickingNo;
    if (oldListId) {
        const pickListRef = this._getPickListDocRef(uid, oldListId);
        const pickListDoc = transaction ? await transaction.get(pickListRef) : await pickListRef.get();
        if (pickListDoc.exists) {
            const lines = this._normalizePickLines(pickListDoc.data()?.lines || []);
            const allDone = lines.length > 0 && lines.every((l) => this._isLineCompleted(l));
            if (!allDone) {
                const nextLines = lines.map((l) => ({ ...l, checkedQty: 0, status: 'PENDING' }));
                if (transaction) {
                    transaction.update(pickListRef, {
                        lines: nextLines,
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                    });
                } else {
                    await pickListRef.update({
                        lines: nextLines,
                        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                    });
                }
            }
        }
    }
    updates[`userStates.${userId}.currentPickingNo`] = null;
    updates[`userStates.${userId}.activePick`] = {};
};

StateManager.prototype.resetUserPick = function (userId) {
    if (!this.user || !this.state) return Promise.reject("Not authenticated");
    const uid = this.user.uid;
    const oldListId = this.state?.userStates?.[userId]?.currentPickingNo || null;
    return this.db.runTransaction(async (transaction) => {
        const docRef = this._getStateDocRef(uid);
        const doc = await transaction.get(docRef);
        if (!doc.exists) return;
        const data = doc.data();
        const updates = { 
            mode: 'INJECT',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp() 
        };
        await this._applyResetLogic(userId, uid, data, updates, transaction);
        transaction.update(docRef, updates);
    }).then(() => {
        if (userId === this.currentUserId) this.clearPickListSubscription();
        this.clearOptimisticPickCompletions(oldListId);
        this.clearOptimisticPickLines(oldListId);
        this.clearTransientWallError();
    }).catch((error) => {
        this._logFirestoreError('resetUserPick', error, uid);
        throw error;
    });
};

StateManager.prototype.cancelAllPicks = function (extraUpdates = {}) {
    if (!this.user || !this.state) return Promise.reject("Not authenticated");
    const uid = this.user.uid;
    return this.db.runTransaction(async (transaction) => {
        const docRef = this._getStateDocRef(uid);
        const doc = await transaction.get(docRef);
        if (!doc.exists) return;
        const data = doc.data();
        const updates = { 
            mode: 'INJECT',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            ...extraUpdates
        };
        for (const uId of Object.keys(data.userStates || {})) {
            await this._applyResetLogic(uId, uid, data, updates, transaction);
        }
        transaction.update(docRef, updates);
    }).then(() => {
        this.clearPickListSubscription();
        this.clearOptimisticPickCompletions();
        this.clearOptimisticPickLines();
        this.clearTransientWallError();
    }).catch((error) => {
        this._logFirestoreError('cancelAllPicks', error, uid);
        throw error;
    });
};

StateManager.prototype.saveInjectPendingSafely = function (pending) {
    if (!this.user || !this.state) return Promise.reject("Not authenticated");
    if (!pending || !pending.requestId) return Promise.reject("Invalid pending");

    const uid = this.user.uid;
    const requestId = pending.requestId;
    const requestedAt = pending.requestedAt || Date.now();

    if (this.isInjectRequestCancelled(requestId)) {
        return Promise.resolve({ skipped: true, reason: 'cancelled-before-start' });
    }

    return this.db.runTransaction(async (transaction) => {
        const docRef = this._getStateDocRef(uid);
        const doc = await transaction.get(docRef);
        if (!doc.exists) return { skipped: true, reason: 'missing-doc' };

        if (this.isInjectRequestCancelled(requestId)) {
            return { skipped: true, reason: 'cancelled-during-transaction' };
        }

        const data = doc.data() || {};
        const userStates = data.userStates || {};
        const currentUserState = userStates[this.currentUserId] || {};
        const remotePending = currentUserState.injectPending || null;
        const remoteCancelled = currentUserState.injectPendingCancelled || null;
        const remoteCancelledRequestId = remoteCancelled?.requestId || null;
        const remoteCancelledAt = remoteCancelled?.cancelledAt || 0;

        const isSameRequestCancelled =
            remoteCancelledRequestId &&
            remoteCancelledRequestId === requestId;

        const isCancelledAfterRequest =
            remoteCancelledAt > 0 &&
            remoteCancelledAt >= requestedAt;

        if (isSameRequestCancelled || isCancelledAfterRequest) {
            return { skipped: true, reason: 'remote-cancelled' };
        }

        if (remotePending) {
            const remoteRequestId = remotePending.requestId || null;
            const remoteRequestedAt = remotePending.requestedAt || 0;
            const isDifferentRequest = remoteRequestId && remoteRequestId !== requestId;
            const isRemoteNewer = remoteRequestedAt > requestedAt;
            if (isDifferentRequest && isRemoteNewer) {
                return { skipped: true, reason: 'newer-remote-pending-exists' };
            }
        } else if (this.isInjectRequestCancelled(requestId)) {
            return { skipped: true, reason: 'cancelled-with-remote-null' };
        }

        const updates = {
            mode: 'INJECT',
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        if (this.isInjectRequestCancelled(requestId)) {
            return { skipped: true, reason: 'cancelled-before-update' };
        }

        if (isSameRequestCancelled || isCancelledAfterRequest) {
            return { skipped: true, reason: 'remote-cancelled-before-update' };
        }

        updates[`userStates.${this.currentUserId}.injectPending`] = { ...pending };
        updates[`userStates.${this.currentUserId}.injectPendingCancelled`] = null;
        transaction.update(docRef, updates);
        return { skipped: false };
    }).catch((error) => {
        this._logFirestoreError('saveInjectPendingSafely', error, uid);
        throw error;
    });
};

// Start picking a list (implements precedence rule and reset rule)
StateManager.prototype.startPicking = function (listId, activePickData) {
    if (!this.user || !this.state) return;
    const uid = this.user.uid;

    return this.db.runTransaction(async (transaction) => {
        const docRef = this._getStateDocRef(uid);
        const doc = await transaction.get(docRef);
        if (!doc.exists) return;
        const data = doc.data();
        const userStates = data.userStates || {};
        
        const updates = {
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        // Reset previous list for THIS user if it was different and incomplete
        const currentUserState = userStates[this.currentUserId];
        if (currentUserState && currentUserState.currentPickingNo !== listId) {
            await this._applyResetLogic(this.currentUserId, uid, data, updates, transaction);
        }

        // Precedence Rule: If anyone else is picking THIS new list, remove it from them
        Object.keys(userStates).forEach(uId => {
            if (uId !== this.currentUserId && userStates[uId].currentPickingNo === listId) {
                updates[`userStates.${uId}.currentPickingNo`] = null;
                updates[`userStates.${uId}.activePick`] = {};
            }
        });

        // Assign to current user
        updates[`userStates.${this.currentUserId}.currentPickingNo`] = listId;
        updates[`userStates.${this.currentUserId}.activePick`] = activePickData;
        updates.mode = 'PICK';

        transaction.update(docRef, updates);
    }).then(() => {
        const previousListId = this.currentPickListId;
        if (previousListId && String(previousListId) !== String(listId)) {
            this.clearOptimisticPickLines(previousListId);
        }
        this.subscribeToPickList(listId);
    }).catch((error) => {
        this._logFirestoreError('startPicking', error, uid);
        throw error;
    });
};

StateManager.prototype.resetPreserveConfig = function () {
    if (!this.user) return Promise.reject("Not authenticated");

    const current = this.state || {};
    const currentConfig = current.config || {};
    const totalBays = currentConfig.bays || 9;

    const splits = {};
    for (let b = 1; b <= totalBays; b++) {
        splits[b] = 1;
    }

    const nextState = {
        mode: 'INJECT',
        config: {
            bays: totalBays,
            maxSplit: currentConfig.maxSplit || 6,
            viewMode: currentConfig.viewMode || 'multi',
            orientation: currentConfig.orientation || 'landscape',
            multiRows: currentConfig.multiRows || 3,
            multiCols: currentConfig.multiCols || 3,
            showOthers: !!currentConfig.showOthers,
            pickMode: currentConfig.pickMode === 'VERIFY' ? 'VERIFY' : 'NORMAL',
            quantityVerification: !!currentConfig.quantityVerification,
            csvFormat: currentConfig.csvFormat || undefined
        },
        slots: {},
        splits,
        injectList: {},
        janIndex: {},
        userStates: {
            user1: { activePick: {}, currentPickingNo: null, injectPending: null, duplicateHighlight: null },
            user2: { activePick: {}, currentPickingNo: null, injectPending: null, duplicateHighlight: null },
            user3: { activePick: {}, currentPickingNo: null, injectPending: null, duplicateHighlight: null },
            user4: { activePick: {}, currentPickingNo: null, injectPending: null, duplicateHighlight: null }
        },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };

    if (nextState.config.csvFormat === undefined) {
        delete nextState.config.csvFormat;
    }

    const uid = this.user.uid;
    return this._deleteAllPickListDocs(uid).then(() => this._getStateDocRef(uid).set(nextState)).then(() => {
        this.clearPickListSubscription();
        this.clearOptimisticPickLines();
    }).catch((error) => {
        this._logFirestoreError('resetPreserveConfig', error, uid);
        throw error;
    });
};

StateManager.prototype.reset = function () {
    if (!this.user) return Promise.reject("Not authenticated");
    const uid = this.user.uid;
    return this._deleteAllPickListDocs(uid).then(() => this.initializeNewSession(uid)).then(() => {
        this.clearPickListSubscription();
        this.clearOptimisticPickLines();
    });
};

StateManager.prototype.completePickLine = function (listId, index) {
    if (!this.user || !listId) return Promise.reject("Not authenticated");
    const uid = this.user.uid;
    return this.db.runTransaction(async (transaction) => {
        const listRef = this._getPickListDocRef(uid, listId);
        const stateRef = this._getStateDocRef(uid);
        const [listDoc, stateDoc] = await Promise.all([transaction.get(listRef), transaction.get(stateRef)]);
        if (!listDoc.exists || !stateDoc.exists) return;
        const lines = this._normalizePickLines(listDoc.data()?.lines || []);
        if (!lines[index] || this._isLineCompleted(lines[index])) return;
        const targetQty = this._toSafeQty(lines[index].qty);
        lines[index] = { ...lines[index], checkedQty: targetQty, status: 'DONE' };
        transaction.update(listRef, {
            lines,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        const data = stateDoc.data() || {};
        const janIndex = data.janIndex || {};
        const activePick = this._buildActivePickFromLines(listId, lines, janIndex);
        transaction.update(stateRef, {
            [`userStates.${this.currentUserId}.activePick`]: activePick,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    });
};

StateManager.prototype.completePickBySlot = function (listId, slotKey) {
    if (!this.user || !listId) return Promise.reject("Not authenticated");
    const uid = this.user.uid;
    return this.db.runTransaction(async (transaction) => {
        const listRef = this._getPickListDocRef(uid, listId);
        const stateRef = this._getStateDocRef(uid);
        const [listDoc, stateDoc] = await Promise.all([transaction.get(listRef), transaction.get(stateRef)]);
        if (!listDoc.exists || !stateDoc.exists) return;
        const data = stateDoc.data() || {};
        const janIndex = data.janIndex || {};
        const lines = this._normalizePickLines(listDoc.data()?.lines || []);
        let changed = false;
        const nextLines = lines.map((line) => {
            if (this._isLineCompleted(line)) return line;
            const lineSlotKey = janIndex?.[line.jan] || 'UNALLOCATED';
            if (lineSlotKey !== slotKey) return line;
            changed = true;
            const targetQty = this._toSafeQty(line.qty);
            return { ...line, checkedQty: targetQty, status: 'DONE' };
        });
        if (!changed) return;
        transaction.update(listRef, {
            lines: nextLines,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        const activePick = this._buildActivePickFromLines(listId, nextLines, janIndex);
        transaction.update(stateRef, {
            [`userStates.${this.currentUserId}.activePick`]: activePick,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    });
};

// Login/Logout methods
StateManager.prototype.login = function (email, password) {
    return this.auth.signInWithEmailAndPassword(email, password);
};

StateManager.prototype.signup = function (email, password) {
    return this.auth.createUserWithEmailAndPassword(email, password);
};

StateManager.prototype.logout = function () {
    return this.auth.signOut();
};

StateManager.prototype._buildActivePickFromLines = function (listId, lines, janIndex) {
    const activePick = {};
    (lines || []).forEach((line) => {
        const qty = this._toSafeQty(line.qty);
        const checkedQty = this._toSafeCheckedQty(line, qty);
        const remainingQty = Math.max(0, qty - checkedQty);
        const slotKey = janIndex?.[line.jan] || 'UNALLOCATED';
        if (!activePick[slotKey]) {
            activePick[slotKey] = {
                totalQty: 0,
                pendingQty: 0,
                skus: [],
                pickNo: listId
            };
        }
        activePick[slotKey].totalQty += qty;
        if (remainingQty > 0) {
            activePick[slotKey].pendingQty += remainingQty;
        }
        if (!activePick[slotKey].skus.includes(line.jan)) {
            activePick[slotKey].skus.push(line.jan);
        }
    });
    return activePick;
};

StateManager.prototype._toSafeQty = function (qty) {
    return Math.max(0, Number(qty) || 0);
};

StateManager.prototype._toSafeCheckedQty = function (line, qtyOverride) {
    const qty = qtyOverride !== undefined ? this._toSafeQty(qtyOverride) : this._toSafeQty(line?.qty);
    const rawCheckedQty = Number(line?.checkedQty);
    if (Number.isFinite(rawCheckedQty)) {
        return Math.min(qty, Math.max(0, rawCheckedQty));
    }
    return line?.status === 'DONE' ? qty : 0;
};

StateManager.prototype._isLineCompleted = function (line) {
    const qty = this._toSafeQty(line?.qty);
    const checkedQty = this._toSafeCheckedQty(line, qty);
    return checkedQty >= qty;
};

StateManager.prototype.consumePickByJan = function (listId, jan, options = {}) {
    if (!this.user || !listId || !jan) return Promise.reject("Not authenticated");
    const uid = this.user.uid;
    const normalizedJan = this.normalizeJanValue(jan);
    if (!normalizedJan) return Promise.resolve({ result: 'not_found' });
    const forceQuantityVerification = options?.quantityVerification;
    return this.db.runTransaction(async (transaction) => {
        const listRef = this._getPickListDocRef(uid, listId);
        const stateRef = this._getStateDocRef(uid);
        const [listDoc, stateDoc] = await Promise.all([transaction.get(listRef), transaction.get(stateRef)]);
        if (!listDoc.exists || !stateDoc.exists) return { result: 'not_found' };

        const stateData = stateDoc.data() || {};
        const janIndex = stateData.janIndex || {};
        const config = stateData.config || {};
        const quantityVerification = typeof forceQuantityVerification === 'boolean'
            ? forceQuantityVerification
            : !!config.quantityVerification;
        const lines = this._normalizePickLines(listDoc.data()?.lines || []);

        const matchedIndexes = [];
        let hasSameJan = false;
        lines.forEach((line, idx) => {
            if (String(line?.jan || '') !== normalizedJan) return;
            hasSameJan = true;
            const qty = this._toSafeQty(line.qty);
            const checkedQty = this._toSafeCheckedQty(line, qty);
            if (checkedQty < qty) {
                matchedIndexes.push(idx);
            }
        });

        if (matchedIndexes.length === 0) {
            return { result: hasSameJan ? 'already_done' : 'not_found' };
        }

        const targetIndex = matchedIndexes[0];
        const targetLine = lines[targetIndex];
        const qty = this._toSafeQty(targetLine.qty);
        const currentCheckedQty = this._toSafeCheckedQty(targetLine, qty);
        const nextCheckedQty = quantityVerification ? Math.min(qty, currentCheckedQty + 1) : qty;
        const nextStatus = nextCheckedQty >= qty ? 'DONE' : (nextCheckedQty > 0 ? 'PARTIAL' : 'PENDING');
        const nextLine = {
            ...targetLine,
            checkedQty: nextCheckedQty,
            status: nextStatus
        };
        const nextLines = [...lines];
        nextLines[targetIndex] = nextLine;

        transaction.update(listRef, {
            lines: nextLines,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        const activePick = this._buildActivePickFromLines(listId, nextLines, janIndex);
        transaction.update(stateRef, {
            [`userStates.${this.currentUserId}.activePick`]: activePick,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });

        return {
            result: nextStatus === 'DONE' ? 'done' : 'partial',
            line: nextLine,
            nextLines,
            index: targetIndex
        };
    });
};

StateManager.prototype._rebuildActivePickForUser = async function (userId, data, nextJanIndex) {
    const userState = data.userStates?.[userId];
    const listId = userState?.currentPickingNo;
    if (!listId || !this.user) return {};
    const pickListDoc = await this._getPickListDocRef(this.user.uid, listId).get();
    const lines = pickListDoc.exists ? (pickListDoc.data()?.lines || []) : [];
    return this._buildActivePickFromLines(listId, lines, nextJanIndex || data.janIndex || {});
};

StateManager.prototype.selectSlot = function (bayId, subId) {
    const currentUserState = this.state?.userStates?.[this.currentUserId];
    const pendingFromFirestore = currentUserState?.injectPending;
    const pendingFromLocal = this.localUiState.injectPendingPreview;
    const pending = pendingFromFirestore || pendingFromLocal;
    if (!pending || pending.status !== "WAITING_SLOT") return;
    if (!this.user) return;

    const slotKey = `${bayId}-${subId}`;
    const pendingJan = pending.jan;
    const pendingRequestId = pending.requestId || null;
    const uid = this.user.uid;
    const docRef = this._getStateDocRef(uid);

    const opId = this.setOptimisticSlot(slotKey, pendingJan);
    this.clearLocalInjectPending();

    const isUnsyncedPendingError = (error) => {
        return error && error.message === 'injectPending is not synced to Firestore yet';
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const attemptSelectSlot = async (retryCount) => {
        try {
            await this.db.runTransaction(async (transaction) => {
                const doc = await transaction.get(docRef);
                if (!doc.exists) return;
                const data = doc.data();
                const userState = data.userStates[this.currentUserId];
                const remotePending = userState?.injectPending;

                const isSameJan = remotePending?.jan === pendingJan;
                const isSameRequestId = !pendingRequestId || remotePending?.requestId === pendingRequestId;
                if (!remotePending || !isSameJan || !isSameRequestId) {
                    throw new Error('injectPending is not synced to Firestore yet');
                }

                const slots = data.slots || {};
                const nextSlots = { ...slots };
                const currentSlot = nextSlots[slotKey] || {};

                let skus = currentSlot.skus || (currentSlot.sku ? [currentSlot.sku] : []);

                if (!skus.includes(pendingJan)) {
                    skus.push(pendingJan);
                }

                nextSlots[slotKey] = { skus: skus };
                const janIndex = data.janIndex || {};
                const nextJanIndex = { ...janIndex, [pendingJan]: slotKey };
                const listId = data.userStates?.[this.currentUserId]?.currentPickingNo;
                let currentLines = [];
                if (listId) {
                    const pickListDoc = await transaction.get(this._getPickListDocRef(uid, listId));
                    currentLines = pickListDoc.exists ? (pickListDoc.data()?.lines || []) : [];
                }
                const rebuiltActivePick = this._buildActivePickFromLines(listId, currentLines, nextJanIndex);

                transaction.update(docRef, {
                    slots: nextSlots,
                    janIndex: nextJanIndex,
                    [`userStates.${this.currentUserId}.activePick`]: rebuiltActivePick,
                    [`userStates.${this.currentUserId}.injectPending`]: null,
                    [`userStates.${this.currentUserId}.injectPendingCancelled`]: null,
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            });
        } catch (error) {
            if (isUnsyncedPendingError(error) && retryCount > 0) {
                await sleep(200);
                return attemptSelectSlot(retryCount - 1);
            }
            throw error;
        }
    };

    return attemptSelectSlot(5).then(() => {
        this.markOptimisticSlotCommitted(slotKey, opId);
    }).catch((error) => {
        this.rollbackOptimisticInject(opId);
        const wasCancelled =
            pendingRequestId &&
            this.localUiState.cancelledInjectRequestIds &&
            this.localUiState.cancelledInjectRequestIds[pendingRequestId];
        if (!wasCancelled) {
            this.setLocalInjectPending({
                jan: pendingJan,
                status: 'WAITING_SLOT',
                requestedAt: pending.requestedAt,
                requestId: pendingRequestId
            });
        }
        this._logFirestoreError('selectSlot', error, uid);
        throw error;
    });
};

StateManager.prototype.unassignSlot = function (slotKey, targetJan) {
    if (!this.user || !this.state) return Promise.reject("Not authenticated");
    const uid = this.user.uid;
    return this.db.runTransaction(async (transaction) => {
        const docRef = this._getStateDocRef(uid);
        const doc = await transaction.get(docRef);
        if (!doc.exists) return;
        const data = doc.data();
        
        if (data.slots && data.slots[slotKey]) {
            const newSlots = { ...data.slots };
            const currentSlot = newSlots[slotKey];
            let skus = currentSlot.skus || (currentSlot.sku ? [currentSlot.sku] : []);
            
            if (targetJan) {
                skus = skus.filter(s => s !== targetJan);
            } else {
                skus = [];
            }
            
            if (skus.length === 0) {
                delete newSlots[slotKey];
            } else {
                newSlots[slotKey] = { skus: skus };
            }
            
            const nextJanIndex = { ...(data.janIndex || {}) };
            if (targetJan) {
                delete nextJanIndex[targetJan];
            } else {
                const removedSkus = currentSlot.skus || (currentSlot.sku ? [currentSlot.sku] : []);
                removedSkus.forEach((jan) => delete nextJanIndex[jan]);
            }
            const listId = data.userStates?.[this.currentUserId]?.currentPickingNo;
            let currentLines = [];
            if (listId) {
                const pickListDoc = await transaction.get(this._getPickListDocRef(uid, listId));
                currentLines = pickListDoc.exists ? (pickListDoc.data()?.lines || []) : [];
            }
            const rebuiltActivePick = this._buildActivePickFromLines(listId, currentLines, nextJanIndex);
            transaction.update(docRef, {
                slots: newSlots,
                janIndex: nextJanIndex,
                [`userStates.${this.currentUserId}.activePick`]: rebuiltActivePick,
                updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
        }
    }).catch((error) => {
        this._logFirestoreError('unassignSlot', error, uid);
        throw error;
    });
};

StateManager.prototype.resetBay = function (bayId) {
    if (!this.user || !this.state) return Promise.reject("Not authenticated");
    const uid = this.user.uid;
    return this.db.runTransaction(async (transaction) => {
        const docRef = this._getStateDocRef(uid);
        const doc = await transaction.get(docRef);
        if (!doc.exists) return;
        const data = doc.data();
        
        const updates = { 
            [`splits.${bayId}`]: 1,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        };
        
        if (data.slots) {
            const newSlots = { ...data.slots };
            let changed = false;
            Object.keys(newSlots).forEach(k => {
                if (k.startsWith(`${bayId}-`)) {
                    delete newSlots[k];
                    changed = true;
                }
            });
            if (changed) {
                const nextJanIndex = { ...(data.janIndex || {}) };
                Object.entries(data.slots || {}).forEach(([key, slot]) => {
                    if (!key.startsWith(`${bayId}-`)) return;
                    const skus = slot?.skus || (slot?.sku ? [slot.sku] : []);
                    skus.forEach((jan) => delete nextJanIndex[jan]);
                });
                const listId = data.userStates?.[this.currentUserId]?.currentPickingNo;
                let currentLines = [];
                if (listId) {
                    const pickListDoc = await transaction.get(this._getPickListDocRef(uid, listId));
                    currentLines = pickListDoc.exists ? (pickListDoc.data()?.lines || []) : [];
                }
                updates.slots = newSlots;
                updates.janIndex = nextJanIndex;
                updates[`userStates.${this.currentUserId}.activePick`] =
                    this._buildActivePickFromLines(listId, currentLines, nextJanIndex);
            }
        }
        
        transaction.update(docRef, updates);
    }).catch((error) => {
        this._logFirestoreError('resetBay', error, uid);
        throw error;
    });
};
