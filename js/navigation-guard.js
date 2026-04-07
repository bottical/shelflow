// Shared navigation guard helpers (Non-module)
(function () {
    const buildNavigationGuardMessage = (work) => {
        if (work.hasInjectInProgress && work.hasPickInProgress) {
            const jan = work.injectPending?.jan || '---';
            return {
                title: '作業途中のデータがあります',
                body: `現在、投入途中（JAN: ${jan}）かつピッキング途中（No.${work.currentPickingNo}）です。キャンセルして移動しますか？`
            };
        }
        if (work.hasInjectInProgress) {
            const jan = work.injectPending?.jan || '---';
            return {
                title: '投入途中のデータがあります',
                body: `現在、JAN ${jan} の投入途中です。キャンセルして移動しますか？`
            };
        }
        return {
            title: 'ピッキング途中のデータがあります',
            body: `現在、ピッキングNo.${work.currentPickingNo} の作業途中です。キャンセルして移動しますか？`
        };
    };

    const buildSwitchPickingMessage = (oldId, newId, work) => {
        if (work?.hasInjectInProgress && work?.hasPickInProgress) {
            const jan = work.injectPending?.jan || '---';
            return {
                title: '作業途中のデータがあります',
                body: `現在、投入途中（JAN: ${jan}）かつピッキングNo.${oldId} の途中です。キャンセルしてピッキングNo.${newId} を開始しますか？`
            };
        }
        if (work?.hasInjectInProgress) {
            const jan = work.injectPending?.jan || '---';
            return {
                title: '投入途中のデータがあります',
                body: `現在、JAN ${jan} の投入途中です。キャンセルしてピッキングNo.${newId} を開始しますか？`
            };
        }
        return {
            title: 'ピッキング途中のデータがあります',
            body: `現在、ピッキングNo.${oldId} の途中です。キャンセルしてピッキングNo.${newId} を開始しますか？`
        };
    };

    const createNavigationHelpers = ({ stateMgr, onCancelError, audioManager }) => {
        let modalOpen = false;

        const showNavigationConfirmModal = ({ title, body }) => {
            if (modalOpen) return Promise.resolve(false);
            modalOpen = true;
            return new Promise((resolve) => {
                const overlay = document.createElement('div');
                overlay.style.position = 'fixed';
                overlay.style.inset = '0';
                overlay.style.background = 'rgba(0,0,0,0.7)';
                overlay.style.display = 'flex';
                overlay.style.alignItems = 'center';
                overlay.style.justifyContent = 'center';
                overlay.style.zIndex = '3000';

                const modal = document.createElement('div');
                modal.className = 'card';
                modal.style.width = '90%';
                modal.style.maxWidth = '420px';
                modal.style.background = '#1e293b';
                modal.style.color = '#fff';
                modal.style.border = '1px solid #334155';

                modal.innerHTML = `
                    <h3 style="margin-top:0; margin-bottom:0.75rem;">${title}</h3>
                    <p style="margin:0 0 1.25rem; line-height:1.6; color:#cbd5e1;">${body}</p>
                    <div style="display:flex; gap:0.75rem; justify-content:flex-end;">
                        <button class="btn btn-outline js-stay-btn">このページにとどまる</button>
                        <button class="btn btn-danger js-leave-btn">キャンセルして移動</button>
                    </div>
                `;

                const close = (result) => {
                    document.removeEventListener('keydown', escHandler);
                    overlay.remove();
                    modalOpen = false;
                    resolve(result);
                };
                const escHandler = (e) => {
                    if (e.key === 'Escape') close(false);
                };

                overlay.appendChild(modal);
                document.body.appendChild(overlay);
                document.addEventListener('keydown', escHandler);

                const leaveBtn = modal.querySelector('.js-leave-btn');
                modal.querySelector('.js-stay-btn').onclick = () => close(false);
                leaveBtn.onclick = () => {
                    leaveBtn.disabled = true;
                    close(true);
                };
                overlay.onclick = (e) => {
                    if (e.target === overlay) close(false);
                };
            });
        };

        const guardedNavigate = async (page) => {
            const work = stateMgr.getInProgressWorkForCurrentUser(stateMgr.state);
            if (!work.hasInjectInProgress && !work.hasPickInProgress) {
                window.location.href = page;
                return;
            }

            const proceed = await showNavigationConfirmModal(buildNavigationGuardMessage(work));
            if (!proceed) return;

            try {
                await stateMgr.cancelCurrentWorkForNavigation();
                window.location.href = page;
            } catch (e) {
                console.error('作業キャンセル後の遷移に失敗しました:', e);
                audioManager?.playErrorSound?.();
                onCancelError?.(e);
            }
        };

        const installBeforeUnloadGuard = () => {
            window.addEventListener('beforeunload', (e) => {
                const work = stateMgr.getInProgressWorkForCurrentUser(stateMgr.state);
                if (!work.hasInjectInProgress && !work.hasPickInProgress) return;
                e.preventDefault();
                e.returnValue = '';
            });
        };

        return {
            buildNavigationGuardMessage,
            buildSwitchPickingMessage,
            showNavigationConfirmModal,
            guardedNavigate,
            installBeforeUnloadGuard
        };
    };

    window.NavigationGuard = {
        createNavigationHelpers,
        buildNavigationGuardMessage,
        buildSwitchPickingMessage
    };
})();
