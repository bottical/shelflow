// Shared Audio Manager (Non-module)
(function () {
    const createAudio = (path) => {
        const audio = new Audio(path);
        audio.preload = 'auto';
        return audio;
    };

    const startAudio = createAudio('audio/start.mp3');
    const multipleStartAudio = createAudio('audio/multiple_start.mp3');
    const completeAudio = createAudio('audio/complete.mp3');
    const errorAudio = createAudio('audio/error.mp3');

    const playAudio = (audio, label) => {
        audio.currentTime = 0;
        audio.play().catch((err) => {
            console.debug(`[audio] ${label} blocked on primary instance`, err);
            const fallback = audio.cloneNode(true);
            fallback.preload = 'auto';
            fallback.currentTime = 0;
            fallback.play().catch((fallbackErr) => {
                console.debug(`[audio] ${label} blocked on fallback instance`, fallbackErr);
            });
        });
    };

    window.AudioManager = {
        playStartSound() {
            playAudio(startAudio, 'start');
        },
        playMultipleStartSound() {
            playAudio(multipleStartAudio, 'multiple_start');
        },
        playCompleteSound() {
            playAudio(completeAudio, 'complete');
        },
        playErrorSound() {
            playAudio(errorAudio, 'error');
        }
    };
})();
