// Pick Mode Logic (Non-module)
(function () {
    document.addEventListener('DOMContentLoaded', () => {
        const listIdInput = document.getElementById('listIdInput');
        const pickTable = document.getElementById('pickTable');
        const currentListTitle = document.getElementById('currentListTitle');
        const sessionDisplay = document.getElementById('sessionDisplay');
        const pickProgressCard = document.getElementById('pickProgressCard');
        const pickProgressText = document.getElementById('pickProgressText');
        const pickProgressFill = document.getElementById('pickProgressFill');

        let lastRenderedPickingNo = null;
        let lastRenderedAllCompleted = false;
        let progressSummary = { total: 0, completed: 0 };

        const stateMgr = new StateManager(
            (state) => render(state),
            (user) => {
                if (user) {
                    sessionDisplay.textContent = `USER: ${user.email}`;
                } else {
                    window.location.href = 'index.html';
                }
            }
        );

        const updateUserSelectorUI = () => {
            const userSelect = document.getElementById('userSelect');
            if (userSelect) {
                userSelect.value = stateMgr.currentUserId;
                const uIdx = stateMgr.currentUserId.slice(-1);
                userSelect.style.borderColor = `var(--user${uIdx})`;
                userSelect.style.color = `var(--user${uIdx})`;
                userSelect.style.backgroundColor = `rgba(255, 255, 255, 0.05)`;
            }
        };

        const showInlineError = (message) => {
            currentListTitle.innerHTML = `<span style="color: var(--danger);">${message}</span>`;
        };
        const navGuard = window.NavigationGuard.createNavigationHelpers({
            stateMgr,
            audioManager: AudioManager,
            onCancelError: () => {
                showInlineError('作業のキャンセルに失敗したため、ページ移動を中止しました。通信状態をご確認ください。');
            }
        });
        const guardedNavigate = navGuard.guardedNavigate;

        const loadListCore = async (id) => {
            const pickList = await stateMgr.loadPickList(id);
            if (!pickList) {
                    AudioManager.playErrorSound();
                    listIdInput.value = '';
                    currentListTitle.innerHTML = `<span style="color: var(--danger);">エラー：見つかりません (${id})</span>`;
                    pickTable.innerHTML = `<tr><td colspan="5" style="padding:3rem; text-align:center; color:var(--danger); font-size:1.2rem; font-weight:bold;">入力されたピッキングNo.「${id}」が存在しません。</td></tr>`;
                    await refreshPickProgress();
                    return;
            }
            listIdInput.value = '';
            const lines = pickList?.lines || [];
            const janIndex = stateMgr.state?.janIndex || {};
            const newActivePick = stateMgr._buildActivePickFromLines(id, lines, janIndex);
            const allCompleted = lines.length > 0 && lines.every(l => l.status === 'DONE');
            if (allCompleted) AudioManager.playErrorSound();
            else AudioManager.playStartSound();
            await stateMgr.startPicking(id, newActivePick);
            await refreshPickProgress();
        };

        const loadList = async (id) => {
            const targetId = (id || '').trim();
            if (!targetId) return;
            const work = stateMgr.getInProgressWorkForCurrentUser(stateMgr.state);
            const currentPickingNo = work.currentPickingNo || null;
            if (!work.hasInjectInProgress && !work.hasPickInProgress) {
                await loadListCore(targetId);
                return;
            }
            if (currentPickingNo && String(currentPickingNo) === String(targetId)) {
                return;
            }

            const message = window.NavigationGuard.buildSwitchPickingMessage(currentPickingNo || '---', targetId, work);
            const proceed = await navGuard.showNavigationConfirmModal(message);
            if (!proceed) return;

            try {
                if (work.hasInjectInProgress) {
                    await stateMgr.cancelInjectPending();
                }
                if (work.hasPickInProgress) {
                    await stateMgr.resetUserPick(stateMgr.currentUserId);
                }
                await loadListCore(targetId);
            } catch (e) {
                console.error('ピッキング切り替え時のキャンセルに失敗しました:', e);
                AudioManager?.playErrorSound?.();
                showInlineError('ピッキング作業のキャンセルに失敗したため、新規読込を中止しました。通信状態をご確認ください。');
            }
        };

        navGuard.installBeforeUnloadGuard();

        const updateProgressUi = () => {
            const total = Number(progressSummary?.total) || 0;
            const completed = Number(progressSummary?.completed) || 0;
            if (!pickProgressCard || !pickProgressText || !pickProgressFill) return;

            pickProgressText.textContent = `${completed} / ${total}`;
            pickProgressFill.style.width = `${total > 0 ? (completed / total) * 100 : 0}%`;
            pickProgressCard.classList.toggle('hidden', total === 0);
        };

        const refreshPickProgress = async () => {
            try {
                progressSummary = await stateMgr.getPickListProgressSummary();
            } catch (error) {
                console.error('全体進捗の取得に失敗しました:', error);
                progressSummary = { total: 0, completed: 0 };
            }
            render(stateMgr.state || {});
        };

        const render = (state) => {
            updateProgressUi();
            updateUserSelectorUI();
            const currentUserState = state.userStates?.[stateMgr.currentUserId] || {};
            const currentPickingNo = currentUserState.currentPickingNo;

            pickTable.innerHTML = '';
            const currentPickLines = stateMgr.currentPickList?.lines || null;
            if (!currentPickingNo) {
                lastRenderedPickingNo = currentPickingNo || null;
                lastRenderedAllCompleted = false;
                const msg = "ピッキングNo.を入力してください";
                pickTable.innerHTML = `<tr><td colspan="5" style="padding:3rem; text-align:center; color:var(--text-muted);">${msg}</td></tr>`;
                currentListTitle.textContent = `ピッキングNo.を入力してください`;
                return;
            }
            if (stateMgr.currentPickListLoading) {
                pickTable.innerHTML = `<tr><td colspan="5" style="padding:3rem; text-align:center; color:var(--text-muted);">読込中...</td></tr>`;
                currentListTitle.textContent = `ピッキングNo. ${currentPickingNo} を読込中...`;
                return;
            }
            if (!currentPickLines) {
                const msg = stateMgr.currentPickListNotFound ? "データが見つかりません" : "読込中...";
                pickTable.innerHTML = `<tr><td colspan="5" style="padding:3rem; text-align:center; color:var(--text-muted);">${msg}</td></tr>`;
                currentListTitle.textContent = `ピッキングNo. ${currentPickingNo}`;
                return;
            }

            const lines = currentPickLines;
            const allCompleted = lines.length > 0 && lines.every(l => l.status === 'DONE');
            if (
                lastRenderedPickingNo === currentPickingNo &&
                lastRenderedAllCompleted === false &&
                allCompleted === true
            ) {
                AudioManager.playCompleteSound();
            }
            if (allCompleted) {
                currentListTitle.innerHTML = `<span style="color: red;">完了済み：${currentPickingNo}</span>`;
            } else {
                currentListTitle.innerHTML = `<span class="user-text-${stateMgr.currentUserId.slice(-1)}">【ユーザー${stateMgr.currentUserId.slice(-1)}】</span> ピッキング中: ${currentPickingNo}`;
            }
            lastRenderedPickingNo = currentPickingNo;
            lastRenderedAllCompleted = allCompleted;
            lines.forEach((line, idx) => {
                const location = state.janIndex?.[line.jan] || "その他";
                const subId = location.includes('-') ? location.split('-')[1] : null;

                const tr = document.createElement('tr');
                tr.style.opacity = line.status === 'DONE' ? 0.5 : 1;
                if (line.status === 'DONE') tr.style.background = '#f8fafc';

                tr.innerHTML = `
                    <td style="padding:1rem; font-weight:600;">...${line.jan.slice(-4)}</td>
                    <td style="padding:1rem; font-size:1.25rem; font-weight:800;">${line.qty}</td>
                    <td style="padding:1rem;">
                        <span style="padding:0.25rem 0.75rem; border-radius:4px; font-weight:800; font-size:1.5rem; color:white; background:${subId ? `hsl(${(subId - 1) * 60 + 200}, 70%, 50%)` : '#eab308'}">
                            ${location}
                        </span>
                    </td>
                    <td style="padding:1rem;">
                        <span class="status-badge ${line.status === 'DONE' ? 'status-done' : 'status-pending'}">
                            ${line.status === 'DONE' ? '完了' : '未完了'}
                        </span>
                    </td>
                    <td style="padding:1rem;">
                        ${line.status === 'PENDING'
                        ? `<button class="btn btn-primary btn-sm complete-btn user-bg-${stateMgr.currentUserId.slice(-1)}" data-index="${idx}">完了</button>`
                        : '✅'}
                    </td>
                `;
                pickTable.appendChild(tr);
            });

            document.querySelectorAll('.complete-btn').forEach(btn => {
                btn.onclick = () => {
                    const idx = btn.getAttribute('data-index');
                    completeLine(idx);
                };
            });
        };

        const completeLine = async (index) => {
            const currentUserState = stateMgr.state.userStates?.[stateMgr.currentUserId];
            const currentPickingNo = currentUserState?.currentPickingNo;
            if (!currentPickingNo) return;

            try {
                await stateMgr.completePickLine(currentPickingNo, Number(index));
                await refreshPickProgress();
            } catch (e) {
                console.error('completeLine failed:', e);
                AudioManager?.playErrorSound?.();
                showInlineError('完了処理に失敗しました。通信状態をご確認ください。');
            }
        };

        // UI Event Listeners
        listIdInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') loadList(listIdInput.value.trim());
        });

        document.getElementById('resetPickingBtn').onclick = async () => {
            const currentUserState = stateMgr.state.userStates?.[stateMgr.currentUserId];
            if (!currentUserState?.currentPickingNo) return;

            try {
                await stateMgr.resetUserPick(stateMgr.currentUserId);
                alert("ピッキング作業をリセットしました（未完了の進捗もクリアされました）");
                await refreshPickProgress();
            } catch (e) {
                console.error('resetPicking failed:', e);
                AudioManager?.playErrorSound?.();
                showInlineError('リセットに失敗しました。通信状態をご確認ください。');
            }
        };

        const userSelect = document.getElementById('userSelect');
        if (userSelect) {
            userSelect.addEventListener('change', (e) => {
                stateMgr.setCurrentUser(e.target.value);
            });
        }

        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const page = link.getAttribute('data-page');
                guardedNavigate(page);
            });
        });

        refreshPickProgress();
    });
})();
