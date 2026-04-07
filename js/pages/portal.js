// Portal Page Logic (Non-module)
(function () {
    document.addEventListener('DOMContentLoaded', () => {
        const loginSection = document.getElementById('loginSection');
        const menuSection = document.getElementById('menuSection');
        const userEmail = document.getElementById('userEmail');
        const emailInput = document.getElementById('emailInput');
        const passInput = document.getElementById('passInput');

        const stateMgr = new StateManager(
            (state) => { /* State updates handled locally or per page */ },
            (user) => {
                document.getElementById('loader')?.classList.add('hidden');
                document.getElementById('appContent')?.classList.remove('hidden');

                if (user) {
                    loginSection.classList.add('hidden');
                    menuSection.classList.remove('hidden');
                    userEmail.textContent = user.email;
                } else {
                    loginSection.classList.remove('hidden');
                    menuSection.classList.add('hidden');
                }
            }
        );

        window.handleAuth = async (action) => {
            const email = emailInput.value;
            const pass = passInput.value;
            try {
                if (action === 'LOGIN') await stateMgr.login(email, pass);
                if (action === 'SIGNUP') await stateMgr.signup(email, pass);
                if (action === 'LOGOUT') await stateMgr.logout();
            } catch (e) {
                alert("認証エラー: " + e.message);
            }
        };

        const openPage = (page) => {
            window.location.href = page;
        };

        document.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', () => {
                const page = item.getAttribute('data-page');
                openPage(page);
            });
        });

        document.getElementById('resetBtn').addEventListener('click', async () => {
            if (confirm("全てのデータを初期化してもよろしいですか？")) {
                try {
                    await stateMgr.resetPreserveConfig();
                    alert("リセット完了");
                } catch (e) {
                    alert("エラー: " + e.message);
                }
            }
        });
    });
})();
