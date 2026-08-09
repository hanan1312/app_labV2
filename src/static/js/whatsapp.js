


const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');
// eagle_api/whatsapp.js

const clients = new Map();
const centerStatuses = new Map();

const authTimeouts = new Map(); 

const delay = ms => new Promise(res => setTimeout(res, ms));

// ==========================================
// 🚨 NEW SELF-HEALING LOGIC
// ==========================================
const wipeSessionAndRestart = (centerId) => {
    console.log(`[${centerId}] 🧹 Wiping expired session data...`);
    // This targets the .wwebjs_auth folder created by LocalAuth
    const sessionPath = path.join(__dirname, '.wwebjs_auth');
    
    try {
        if (fs.existsSync(sessionPath)) {
            // Delete the corrupted session folder completely
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`[${centerId}] ✅ Expired session deleted.`);
        }
    } catch (err) {
        console.error(`[${centerId}] Error deleting session folder:`, err);
    }
    
    console.log(`[${centerId}] 🔄 Exiting process. PM2 will now restart the bot and generate a new QR Code...`);
    // Exiting with code 1 tells PM2 to instantly reboot the microservice
    process.exit(1); 
};
// ==========================================

const initializeClient = (centerId) => {
    if (clients.has(centerId)) return;

    centerStatuses.set(centerId, { status: 'initializing', message: 'Starting WhatsApp..' });
    console.log(`[${centerId}] Starting New WhatsApp Session...`);

    const client = new Client({
        authStrategy: new LocalAuth({ clientId: centerId }), 
        puppeteer: {
//            executablePath: '/snap/bin/chromium',
            executablePath: '/usr/bin/chromium',
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', 
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-translate',
                '--hide-scrollbars',
                '--metrics-recording-only',
                '--mute-audio',
                '--no-default-browser-check',
                '--safebrowsing-disable-auto-update'
            ]
        }
    });

    client.on('qr', (qr) => {
        console.log(`[${centerId}] A New QR code Is Generated.`);
        
        qrcode.generate(qr, {small: true}); 
        
        centerStatuses.set(centerId, { status: 'qr', qrCode: qr, message: 'Waiting for Scanning The QR Code ...' });
        
        if (!authTimeouts.has(centerId)) {
            const timeout = setTimeout(() => {
                console.log(`[${centerId}] ⏳ Session Being Closed For Memory Saving.`);
                centerStatuses.set(centerId, { status: 'offline', message: 'Session Expired, Please Start New One...' });
                client.destroy(); 
                clients.delete(centerId);
                authTimeouts.delete(centerId);
            }, 120000); 
            authTimeouts.set(centerId, timeout);
        }
    });
    const isCommunicationReady = new Map();
    client.on('ready', () => {
        console.log(`[${centerId}] ✅ Whats App Connected Succsessfully!`);
        centerStatuses.set(centerId, { status: 'connected', message: 'Connecting And Ready For Automatic Messaging' });
        
        setTimeout(() => {
            isCommunicationReady.set(centerId, true);
            centerStatuses.set(centerId, { status: 'connected', message: 'Ready' });
        }, 5000);
    });

    // 🚨 UPDATED TO USE WIPE FUNCTION
    client.on('disconnected', (reason) => {
        console.log(`[${centerId}] ❌ تم قطع الاتصال: ${reason}`);
        centerStatuses.set(centerId, { status: 'offline', message: 'Phone Disconnected' });
        clients.delete(centerId);
        client.destroy().then(() => wipeSessionAndRestart(centerId)).catch(() => wipeSessionAndRestart(centerId)); 
    });

    // 🚨 UPDATED TO USE WIPE FUNCTION
    client.on('auth_failure', msg => {
        console.error(`[${centerId}] ❌Pairing Failure :`, msg);
        centerStatuses.set(centerId, { status: 'offline', message: 'Failed To Connect, Please Try Again' });
        clients.delete(centerId);
        client.destroy().then(() => wipeSessionAndRestart(centerId)).catch(() => wipeSessionAndRestart(centerId));
    });

    client.initialize().catch(err => {
         console.error(`[${centerId}] ❌ ERR: Connection Time Out:`, err);
         centerStatuses.set(centerId, { status: 'error', message: 'Error Opening the Browser' });
         client.destroy();
    });
    
    clients.set(centerId, client); 
};

const getStatus = (centerId) => {
    if (!clients.has(centerId)) {
        initializeClient(centerId);
        return { status: 'offline', message: 'Processing..' };
    }
    return centerStatuses.get(centerId) || { status: 'offline' };
};

const logoutClient = async (centerId) => {
    const client = clients.get(centerId);
    if (client) {
        try {
            await client.destroy(); 
        } catch (e) {
            console.log(`[${centerId}] Error during destroy:`, e.message);
        }
        clients.delete(centerId);
        centerStatuses.set(centerId, { status: 'offline', message: 'تم تسجيل الخروج بنجاح' });
        console.log(`[${centerId}] 🧹 Logged Out Successfully`);
        
        // Also wipe session on manual logout to keep things clean!
        wipeSessionAndRestart(centerId);
    }
};

// Puppeteer throws these when the underlying page reloaded or lost context mid-operation
// (e.g. WhatsApp Web re-rendering against a newer bundle than our cached one) — the client
// object is left holding stale frame/execution-context references and every subsequent send
// fails the same way until something recycles it. None of our own event handlers
// (disconnected/auth_failure) catch this case since WhatsApp itself never actually
// disconnected, so we detect it here and reinitialize instead of leaving it broken.
const isRecoverableBrowserError = (error) => {
    const msg = (error && error.message) || '';
    return /detached Frame|Session closed|Target closed|Execution context was destroyed|Protocol error/i.test(msg);
};

const reinitializeClient = async (centerId) => {
    console.log(`[${centerId}] 🔁 Recovering from a broken browser session — reinitializing...`);
    const client = clients.get(centerId);
    clients.delete(centerId);
    centerStatuses.set(centerId, { status: 'initializing', message: 'Recovering connection...' });
    if (client) {
        try {
            await client.destroy();
        } catch (e) {
            // Already broken — nothing to clean up.
        }
    }
    // LocalAuth's persisted session means this comes back without a fresh QR scan, as long
    // as WhatsApp itself never actually logged the session out.
    initializeClient(centerId);
};

const sendMessage = async (centerId, phone, message, pdfUrl = null) => {
    const client = clients.get(centerId);
    if (!client) throw new Error("لم يتم تشغيل الواتساب لهذا السنتر بعد");

    const status = centerStatuses.get(centerId);
    if (status && status.status !== 'connected') throw new Error("الواتساب غير متصل، يرجى مسح الباركود أولاً");

    try {
        // FIX 1: Safely cast the phone variable to a string before trimming
        let formattedPhone = String(phone).trim();
        if (formattedPhone.startsWith('01')) formattedPhone = `2${formattedPhone}`;
        else if (!formattedPhone.startsWith('20')) formattedPhone = `20${formattedPhone}`;

        const chatId = `${formattedPhone}@c.us`;

        const isRegistered = await client.isRegisteredUser(chatId);
        if (!isRegistered) {
            console.log(`[${centerId}] ⚠️ The Number ${formattedPhone} Has No WhatsApp Service.`);
            return false;
        }

        // FIX 2: Safely check if the chat exists before applying typing indicators
        try {
            const chat = await client.getChatById(chatId);
            if (chat) {
                await chat.sendStateTyping();
                await delay(Math.floor(Math.random() * 2000) + 1500);
            }
        } catch (chatError) {
            console.log(`[${centerId}] No prior chat history, skipping typing indicator.`);
        }

        if (pdfUrl) {
            try {
                const media = await MessageMedia.fromUrl(pdfUrl);
                await client.sendMessage(chatId, media, { caption: message });
                console.log(`[${centerId}] 📩 PDF & Message sent to: ${formattedPhone}`);
            } catch (mediaError) {
                console.error(`[${centerId}] Failed to download PDF:`, mediaError);
                await client.sendMessage(chatId, message + `\n\nLink: ${pdfUrl}`);
            }
        } else {
            await client.sendMessage(chatId, message);
            console.log(`[${centerId}] 📩 Text sent to: ${formattedPhone}`);
        }
        
        try {
            const chat = await client.getChatById(chatId);
            if (chat) await chat.clearState();
        } catch (e) {}

        return true;
    } catch (error) {
        console.error(`[${centerId}] ❌ Failed To Send To : ${phone}:`, error.message);
        if (isRecoverableBrowserError(error)) {
            // Fire-and-forget: this send still fails and reports back to the caller as
            // before, but the next one gets a healthy client instead of the same broken one.
            reinitializeClient(centerId).catch(err =>
                console.error(`[${centerId}] Failed to reinitialize after browser error:`, err.message));
        }
        throw error;
    }
};


module.exports = { getStatus, logoutClient, sendMessage };

