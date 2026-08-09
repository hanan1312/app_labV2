const express = require('express');
const cors = require('cors');
const { sendMessage, getStatus } = require('./whatsapp'); 

const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

getStatus('lab'); 

app.post('/api/whatsapp/send', async (req, res) => {
    // Destructure pdfUrl just in case you use it later
    const { centerId, phone, message, pdfUrl } = req.body;

    if (!centerId || !phone || !message) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const success = await sendMessage(centerId, phone, message, pdfUrl);
        if (success) {
            res.status(200).json({ success: true, message: 'WhatsApp message sent silently!' });
        } else {
            res.status(400).json({ error: 'Number not registered on WhatsApp' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
app.post('/api/sms/send', async (req, res) => {
    const { centerId, phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'Missing phone or message payload' });
    }

    try {
        let formattedPhone = phone.trim();
        // Standardize Egyptian phone numbers just like WhatsApp logic
        if (formattedPhone.startsWith('01')) formattedPhone = `2${formattedPhone}`;
        else if (!formattedPhone.startsWith('20')) formattedPhone = `20${formattedPhone}`;

        console.log(`[SMS Gateway] Initiating SMS text to: ${formattedPhone}`);
        console.log(`[SMS Message]: ${message}`);

        // -------------------------------------------------------------
        // 🚨 PLUG YOUR SMS PROVIDER API HERE
        // (e.g., Twilio, Vodafone, Orange, or a local SMS Gateway provider)
        // -------------------------------------------------------------
        // Example: 
        // await smsProvider.send({ to: formattedPhone, body: message });

        res.status(200).json({ success: true, message: 'SMS notification processed successfully!' });
    } catch (error) {
        console.error("❌ SMS Dispatch Failed:", error.message);
        res.status(500).json({ error: error.message });
    }
});
app.get('/api/whatsapp/status', (req, res) => {
    const centerId = req.query.centerId || 'lab';
    
    // getStatus is already imported from whatsapp.js at the top of your file
    const status = getStatus(centerId); 
    
    res.json(status);
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Node Server: WhatsApp Microservice running on port ${PORT}`);
});
