import { translate } from './i18nHelpers.js';
import { modalManager } from '../managers/ModalManager.js';

/**
 * Ask the user to confirm a scoped Civitai stats refresh.
 *
 * Unlike the update check, this prompt has no "don't ask again" option: the
 * scope changes with the active folder/search/filters, so the number of models
 * about to be fetched is different every time and worth showing.
 *
 * @param {string} displayName - Model type label, e.g. "LoRA".
 * @param {number} count - How many models match the current filters.
 * @returns {Promise<boolean>} Whether the refresh should proceed.
 */
export async function confirmStatsRefresh(displayName, count) {
    const modalElement = document.getElementById('refreshStatsConfirmModal');
    if (!modalElement) {
        return true;
    }

    // showModal() is a silent no-op for an unregistered modal, which would leave
    // the confirmation promise pending forever. Proceed instead of hanging.
    if (!modalManager.getModal?.('refreshStatsConfirmModal')) {
        console.warn('refreshStatsConfirmModal is not registered; skipping confirmation');
        return true;
    }

    const typePlural = getTypePlural(displayName);

    const titleElement = modalElement.querySelector('[data-role="title"]');
    if (titleElement) {
        titleElement.textContent = translate(
            'modals.refreshStats.title',
            { count, type: displayName, typePlural },
            `Fetch Civitai stats for ${count} ${typePlural}?`
        );
    }

    const messageElement = modalElement.querySelector('[data-role="message"]');
    if (messageElement) {
        messageElement.textContent = translate(
            'modals.refreshStats.message',
            { count, type: displayName, typePlural },
            `This fetches like and download counts for the ${count} ${typePlural} matching your current folder and filters.`
        );
    }

    const tipElement = modalElement.querySelector('[data-role="tip"]');
    if (tipElement) {
        tipElement.textContent = translate(
            'modals.refreshStats.tip',
            { type: displayName, typePlural },
            'To fetch fewer, narrow the folder or search first — only what is currently listed gets updated.'
        );
    }

    const confirmButton = modalElement.querySelector('[data-action="confirm-refresh-stats"]');
    const cancelButton = modalElement.querySelector('[data-action="cancel-refresh-stats"]');

    if (!confirmButton || !cancelButton) {
        return true;
    }

    return new Promise((resolve) => {
        let resolved = false;

        const cleanup = () => {
            confirmButton.removeEventListener('click', handleConfirm);
            cancelButton.removeEventListener('click', handleCancel);
        };

        const finalize = (proceed) => {
            if (resolved) {
                return;
            }

            resolved = true;
            cleanup();
            resolve(proceed);
        };

        const handleConfirm = (event) => {
            event.preventDefault();
            finalize(true);
            modalManager.closeModal('refreshStatsConfirmModal');
        };

        const handleCancel = (event) => {
            event.preventDefault();
            finalize(false);
            modalManager.closeModal('refreshStatsConfirmModal');
        };

        confirmButton.addEventListener('click', handleConfirm);
        cancelButton.addEventListener('click', handleCancel);

        modalManager.showModal('refreshStatsConfirmModal', null, () => finalize(false));
    });
}

function getTypePlural(displayName) {
    if (!displayName) {
        return 'models';
    }

    const lower = displayName.toLowerCase();
    if (lower.endsWith('s')) {
        return displayName;
    }

    return `${displayName}s`;
}
