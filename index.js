const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const NodeCache = require('node-cache');
const { GoogleGenAI } = require('@google/genai');

// إعداد التخزين المؤقت (يحفظ الترجمات لمدة 7 أيام)
const subCache = new NodeCache({ stdTTL: 604800 });

// تهيئة الذكاء الاصطناعي
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. مواصفات الإضافة
const manifest = {
    id: 'org.netflix.arabic.ai',
    version: '1.0.0',
    name: 'Netflix Arabic AI 🎬',
    description: 'ترجمة عربية احترافية وسينمائية تلقائية مدعومة بالذكاء الاصطناعي بأسلوب Netflix',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
};

const builder = new addonBuilder(manifest);

// 2. دالة جلب الترجمة الإنجليزية
async function fetchBestEnglishSub(type, id) {
    try {
        const url = `https://opensubtitles-v3.strem.io/subtitles/${type}/${id}.json`;
        const response = await axios.get(url, { timeout: 8000 });
        const subtitles = response.data.subtitles || [];

        const engSubs = subtitles.filter(sub => sub.lang === 'eng' || sub.lang === 'en');
        if (engSubs.length === 0) return null;

        const srtResponse = await axios.get(engSubs[0].url, { timeout: 8000 });
        return srtResponse.data;
    } catch (error) {
        console.error('خطأ في جلب الترجمة الأصلية:', error.message);
        return null;
    }
}

// 3. تحليل ملف الـ SRT
function parseSRT(srtText) {
    const blocks = srtText.trim().split(/\r?\n\r?\n/);
    return blocks.map(block => {
        const lines = block.split(/\r?\n/);
        if (lines.length >= 3) {
            return {
                index: lines[0],
                timestamp: lines[1],
                text: lines.slice(2).join('\n')
            };
        }
        return null;
    }).filter(Boolean);
}

function buildSRT(blocks) {
    return blocks.map(b => `${b.index}\n${b.timestamp}\n${b.text}`).join('\n\n');
}

// 4. الترجمة عبر الذكاء الاصطناعي بأسلوب Netflix
async function translateBatchWithAI(blocks) {
    const payload = blocks.map((b, i) => ({ id: i, text: b.text }));

    const systemPrompt = `أنت مترجم أفلام ومسلسلات محترف تعمل لصالح منصة Netflix.
مهمتك ترجمة حوارات الأفلام من الإنجليزية إلى اللغة العربية وفق القواعد الصارمة التالية:
1. استخدم لغة عربية فصحى معاصرة، سلسة، وطبيعية جداً.
2. ابتعد تماماً عن الترجمة الحرفية؛ انقل المعنى والمشاعر بأسلوب درامي احترافي.
3. اجعل الجمل قصيرة ومكثفة ومناسبة للقراءة السريعة على الشاشة.
4. حافظ على تطابق أرقام الـ id في مصفوفة JSON ولا تدمج أو تحذف أي سطر.
5. أرجع النتيجة بصيغة JSON صالحة فقط بنفس الهيكل: [{"id": 0, "text": "النص المترجم"}] دون أي كلام إضافي.`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: JSON.stringify(payload),
            config: {
                systemInstruction: systemPrompt,
                responseMimeType: 'application/json',
                temperature: 0.3
            }
        });

        const translatedArray = JSON.parse(response.text);
        
        return blocks.map((block, index) => {
            const found = translatedArray.find(item => item.id === index);
            return {
                ...block,
                text: found ? found.text : block.text
            };
        });
    } catch (error) {
        console.error('خطأ في الترجمة عبر AI:', error.message);
        throw error;
    }
}

// 5. معالج طلبات Stremio
builder.defineSubtitlesHandler(async ({ type, id }) => {
    if (subCache.has(id)) {
        return {
            subtitles: [{
                id: `netflix-ai-${id}`,
                url: `${process.env.HOST_URL}/srt/${encodeURIComponent(id)}.srt`,
                lang: 'ara'
            }]
        };
    }

    const rawSrt = await fetchBestEnglishSub(type, id);
    if (!rawSrt) return { subtitles: [] };

    const parsedBlocks = parseSRT(rawSrt);
    const batchSize = 150;
    let translatedBlocks = [];

    for (let i = 0; i < parsedBlocks.length; i += batchSize) {
        const batch = parsedBlocks.slice(i, i + batchSize);
        const translatedBatch = await translateBatchWithAI(batch);
        translatedBlocks = translatedBlocks.concat(translatedBatch);
    }

    const finalSrt = buildStrT_Safe(translatedBlocks); // استخدام الدالة الآمنة
    subCache.set(id, finalSrt);

    return {
        subtitles: [{
            id: `netflix-ai-${id}`,
            url: `${process.env.HOST_URL}/srt/${encodeURIComponent(id)}.srt`,
            lang: 'ara'
        }]
    };
});

function buildStrT_Safe(blocks) {
    return blocks.map(b => `${b.index}\n${b.timestamp}\n${b.text}`).join('\n\n');
}

// 6. إعداد السيرفر
const app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', '*');
    next();
});

app.get('/srt/:id.srt', (req, res) => {
    const id = decodeURIComponent(req.params.id);
    const srtContent = subCache.get(id);

    if (!srtContent) {
        return res.status(404).send('Subtitle not found or expired');
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(srtContent);
});

// الطريقة الصحيحة السليمة لـ Stremio Router
app.use(getRouter(builder.getInterface()));

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
    console.log(`الإضافة تعمل الآن بنجاح على البورت ${PORT}`);
});