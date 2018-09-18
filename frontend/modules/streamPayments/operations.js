import orderBy from "lodash/orderBy";
import * as statusCodes from "config/status-codes";
import { appActions } from "modules/app";
import { lightningOperations } from "modules/lightning";
import { channelsOperations } from "modules/channels";
import { store } from "store/configure-store";
import { db, successPromise, errorPromise } from "additional";
import { error } from "modules/notifications";
import { accountOperations, accountTypes } from "modules/account";
import { STREAM_ERROR_TIMEOUT } from "config/consts";
import { streamPaymentActions as actions, streamPaymentTypes as types } from "modules/streamPayments";
import { addInvoiceRemote } from "../lightning/operations";

async function pauseDbStreams() {
    try {
        await db.streamBuilder()
            .update()
            .set({ status: "pause" })
            .where("status = :status", { status: "run" })
            .execute();
    } catch (e) {
        console.error(e);
    }
}

function openStreamPaymentDetailsModal() {
    return dispatch => dispatch(appActions.setModalState(types.MODAL_STATE_STREAM_PAYMENT_DETAILS));
}

function loadStreams() {
    return async (dispatch) => {
        const response = await db.streamBuilder()
            .getMany();
        const streams = orderBy(response, "date", "desc")
            .reduce((reducedStreams, item) => {
                if (item.status === "end") {
                    return reducedStreams;
                }
                reducedStreams.push({
                    ...item,
                    contact_name: "",
                    lightningID: item.lightningID,
                    partsRequested: item.partsPaid,
                    status: item.status === "run" ? types.STREAM_PAYMENT_STREAMING : types.STREAM_PAYMENT_PAUSED,
                    streamId: item.id,
                    uuid: item.id,
                });
                return reducedStreams;
            }, []);
        dispatch(actions.setStreamPayments(streams));
        return successPromise();
    };
}

function clearPrepareStreamPayment() {
    return async (dispatch, getState) => {
        dispatch(actions.prepareStreamPayment(null));
    };
}

function prepareStreamPayment(
    lightningID,
    price,
    delay = 1000,
    totalParts = 0,
    paymentName = null,
    contact_name = "",
    partsPaid = 0,
    date = Date.now(),
) {
    return async (dispatch, getState) => {
        if (getState().account.kernelConnectIndicator !== accountTypes.KERNEL_CONNECTED) {
            return errorPromise(statusCodes.EXCEPTION_ACCOUNT_NO_KERNEL, prepareStreamPayment);
        }
        const name = paymentName || "Stream payment";
        const id = btoa(unescape(encodeURIComponent(`${name}_${new Date().getTime()}`)));
        const memo = `stream_payment_${new Date().getTime()}`;
        const fees = await dispatch(lightningOperations.getLightningFee(lightningID, price));
        if (!fees.ok) {
            return errorPromise(fees.error, prepareStreamPayment);
        }
        const details = {
            contact_name,
            date,
            delay,
            fee: fees.response.fee,
            id,
            lightningID,
            memo,
            name,
            partsPaid,
            partsRequested: partsPaid,
            price,
            status: types.STREAM_PAYMENT_PAUSED,
            streamId: id,
            totalParts,
            uuid: id,
        };
        dispatch(actions.prepareStreamPayment(details));
        return successPromise();
    };
}

function addStreamPaymentToList() {
    return async (dispatch, getState) => {
        const details = getState().streamPayment.streamDetails;
        if (!details) {
            return errorPromise(statusCodes.EXCEPTION_STREAM_DETAILS_REQUIRED, addStreamPaymentToList);
        }
        dispatch(actions.addStreamPaymentToList());
        try {
            await db.streamBuilder()
                .insert()
                .values({
                    date: details.date,
                    delay: details.delay,
                    id: details.uuid,
                    lightningID: details.lightningID,
                    memo: `stream_payment_${details.uuid}`,
                    name: details.name,
                    partsPaid: details.partsPaid,
                    price: details.price,
                    status: "pause",
                    totalParts: details.totalParts,
                })
                .execute();
        } catch (e) {
            /* istanbul ignore next */
            console.error(statusCodes.EXCEPTION_EXTRA, e);
        }
        return successPromise();
    };
}

function pauseStreamPayment(streamId) {
    return ((dispatch, getState) => {
        const payment = getState().streamPayment.streams.filter(item => item.streamId === streamId)[0];
        if (!payment) {
            return;
        }
        clearTimeout(payment.errorTimeoutId);
        clearInterval(payment.paymentIntervalId);
        dispatch(actions.setStreamPaymentIntervalId(payment.streamId, null));
        dispatch(actions.setStreamPaymentStatus(payment.uuid, types.STREAM_PAYMENT_PAUSED));
        db.streamBuilder()
            .update()
            .set({ partsPaid: payment.partsPaid, status: "pause" })
            .where("id = :id", { id: payment.uuid })
            .execute();
    });
}

function pauseAllStreams() {
    return (dispatch, getState) => {
        getState()
            .streamPayment
            .streams
            .forEach((item, key) => {
                if (item.status === types.STREAM_PAYMENT_STREAMING) {
                    dispatch(pauseStreamPayment(item.streamId));
                }
            });
    };
}

function finishStreamPayment(streamId) {
    return (dispatch, getState) => {
        const payment = getState().streamPayment.streams.filter(item => item.streamId === streamId)[0];
        // TODO: Multiple parallel stream payments
        dispatch(pauseAllStreams());
        if (!payment) {
            return;
        }
        clearTimeout(payment.errorTimeoutId);
        clearInterval(payment.paymentIntervalId);
        dispatch(actions.setStreamPaymentIntervalId(payment.streamId, null));
        dispatch(actions.setStreamPaymentStatus(payment.streamId, types.STREAM_PAYMENT_FINISHED));
        db.streamBuilder()
            .update()
            .set({ partsPaid: payment.partsPaid, status: "end" })
            .where("id = :id", { id: payment.uuid })
            .execute();
    };
}

function handleStreamError(streamId, err) {
    return async (dispatch, getState) => {
        dispatch(pauseStreamPayment(streamId));
        dispatch(error({
            message: err,
            uid: "stream_error",
        }));
    };
}

function makeStreamIteration(streamId) {
    return async (dispatch, getState) => {
        const payment = getState().streamPayment.streams.filter(item => item.streamId === streamId)[0];
        if (!payment) {
            dispatch(handleStreamError(streamId, statusCodes.EXCEPTION_STREAM_NOT_IN_STORE));
            return;
        }
        if (payment.partsPaid + payment.partsRequested >= payment.totalParts) {
            if (payment.partsRequested === 0) {
                dispatch(finishStreamPayment(streamId));
            }
            return;
        }
        const errorTimeoutId = setTimeout(
            dispatch(handleStreamError(streamId, statusCodes.EXCEPTION_LND_NOT_RESPONDING)),
            STREAM_ERROR_TIMEOUT,
        );
        dispatch(actions.setStreamErrorTimeoutId(payment.streamId, errorTimeoutId));
        let response = await window.ipcClient("addInvoiceRemote", {
            lightning_id: payment.lightningID,
            memo: payment.memo,
            value: payment.price.toString,
        });
        if (!response.ok) {
            const err = response.error.toLowerCase().indexOf("invalid json response") !== -1
                ? statusCodes.EXCEPTION_REMOTE_OFFLINE
                : response.error;
            dispatch(handleStreamError(streamId, err));
            return;
        }
        dispatch(actions.changeStreamPartsPending(streamId, 1));
        response = await window.ipcClient("sendPayment", { payment_request: response.response.payment_request });
        clearTimeout(errorTimeoutId);
        dispatch(actions.changeStreamPartsPending(streamId, -1));
        if (!response.ok) {
            dispatch(handleStreamError(streamId, response.error));
            return;
        }
        dispatch(actions.changeStreamPartsPaid(streamId, 1));
        dispatch(accountOperations.checkBalance());
        dispatch(channelsOperations.getChannels());
        try {
            const parts =
                getState().streamPayment.streams.filter(item => item.streamId === streamId)[0].partsPaid;
            db.streamBuilder()
                .update()
                .set({ partsPaid: parts })
                .where("id = :id", { id: payment.uuid })
                .execute();
            db.streamPartBuilder()
                .insert()
                .values({
                    payment_hash: response.response.payment_hash,
                    stream: payment.uuid,
                })
                .execute();
        } catch (e) {
            /* istanbul ignore next */
            console.error(statusCodes.EXCEPTION_EXTRA, e);
        }
    };
}

function startStreamPayment(streamId) {
    return (dispatch, getState) => {
        const payment = getState().streamPayment.streams.filter(item => item.streamId === streamId)[0];
        // TODO: Multiple parallel stream payments
        dispatch(pauseAllStreams());
        if (!payment) {
            return;
        }
        const paymentIntervalId = setInterval(dispatch(makeStreamIteration(payment.streamId)), payment.delay);
        dispatch(actions.setStreamPaymentIntervalId(payment.streamId, paymentIntervalId));
        dispatch(actions.setStreamPaymentStatus(payment.streamId, types.STREAM_PAYMENT_STREAMING));
        db.streamBuilder()
            .update()
            .set({ partsPaid: payment.partsPaid, status: "run" })
            .where("id = :id", { id: payment.uuid })
            .execute();
    };
}

export {
    pauseDbStreams,
    prepareStreamPayment,
    startStreamPayment,
    finishStreamPayment,
    pauseStreamPayment,
    openStreamPaymentDetailsModal,
    addStreamPaymentToList,
    loadStreams,
    clearPrepareStreamPayment,
    pauseAllStreams,
    makeStreamIteration,
    handleStreamError,
};
