const express = require('express');
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const axios = require('axios');
const NodeCache = require('node-cache');
const { GoogleGenAI } = require('@google/genai');

// إعداد التخزين المؤقت (يحفظ الترجمات لمدة 7 أيام لتسريع التشغيل وتوفير التكلفة)
const subCache = new NodeCache({ stdTTL: 604800 });

// تهيئة الذكاء الاصطناعي (ضع مفتاح API الخاص بك في متغيرات البيئة)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// 1. تعريف مواصفات الإضافة لـ Stremio
const manifest = {
    id: 'org.netflix.arabic.ai',
    version: '1.0.0',
    name: 'Netflix Arabic AI 🎬',
    description: 'ترجمة عربية احترافية وسينمائية تلقائية مدعومة بالذكاء الاصطناعي بأسلوب Netflix',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'], // يدعم معرّفات IMDB
    catalogs: []
};

const builder = new addonBuilder(manifest);

// 2. دالة جلب أفضل ترجمة إنجليزية متاحة من OpenSubtitles (واجهة Stremio المفتوحة)
async function fetchBestEnglishSub(type, id) {
    try {
        const url = `https://opensubtitles-v3.strem.io/subtitles/${type}/${id}.json`;
        const response = await axios.get(url, { timeout: 8000 });
        const subtitles = response.data.subtitles || [];

        // تصفية الترجمات الإنجليزية فقط واختيار الأفضل (الأولى غالباً هي الأعلى تقييماً/تحميلاً)
        const engSubs = subtitles.filter(sub => sub.lang === 'eng' || sub.lang === 'en');
        if (engSubs.length === 0) return null;

        // تحميل محتوى ملف الـ SRT
        const srtResponse = await axios.get(engSubs[0].url, { timeout: 8000 });
        return srtResponse.data;
    } catch (error) {
        console.error('خطأ في جلب الترجمة الأصلية:', error.message);
        return null;
    }
}

// 3. تقسيم ملف الـ SRT إلى كتل (Blocks) للحفاظ على التوقيت بدقة
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

// إعادة تجميع الكتل إلى صيغة SRT صالحة
function buildSRT(blocks) {
    return blocks.map(b => `${b.index}\n${b.timestamp}\n${b.text}`).join('\n\n');
}

// 4. ترجمة النصوص عبر الذكاء الاصطناعي بأسلوب Netflix
async function translateBatchWithAI(blocks) {
    // نرسل النصوص فقط بصيغة JSON مرقمة لضمان عدم العبث بالتوقيت أو دمج السطور
    const payload = blocks.map((b, i) => ({ id: i, text: b.text }));

    const systemPrompt = `أنت مترجم أفلام ومسلسلات محترف تعمل لصالح منصة Netflix.
مهمتك ترجمة حوارات الأفلام من الإنجليزية إلى اللغة العربية وفق القواعد الصارمة التالية:
1. استخدم لغة عربية فصحى معاصرة، سلسة، وطبيعية جداً (تُسمى لغة الحوار الدرامي).
2. ابتعد تماماً عن الترجمة الحرفية أو الركيكة؛ انقل المعنى والمشاعر والسخرية والمصطلحات العامية (Slang) بما يقابلها طبيعياً في العربية.
3. اجعل الجمل قصيرة ومكثفة ومناسبة للقراءة السريعة على الشاشة (سطرين كحد أقصى).
4. حافظ على تطابق أرقام الـ id في مصفوفة JSON ولا تدمج أو تحذف أي سطر.
5. أرجع النتيجة بصيغة JSON صالحة فقط بنفس الهيكل: [{"id": 0, "text": "النص المترجم"}] دون أي كلام إضافي.`;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: JSON.stringify(payload),
            config: {
                systemInstruction: systemPrompt,
                responseMimeType: 'application/json',
                temperature: 0.3 // توازن مثالي بين الإبداع الدرامي والدقة
            }
        });

        const translatedArray = JSON.parse(response.text);
        
        // دمج الترجمة مع الطوابع الزمنية الأصلية
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

// 5. معالج طلبات الترجمة من Stremio
builder.defineSubtitlesHandler(async ({ type, id }) => {
    // التحقق من وجود الترجمة مسبقاً في الذاكرة
    if (subCache.has(id)) {
        return {
            subtitles: [{
                id: `netflix-ai-${id}`,
                url: `${process.env.HOST_URL}/srt/${encodeURIComponent(id)}.srt`,
                lang: 'ara' // رمز اللغة العربية المعتمد في Stremio
            }]
        };
    }

    // بدء عملية الجلب والترجمة في الخلفية أو بشكل مباشر
    const rawSrt = await fetchBestEnglishSub(type, id);
    if (!rawSrt) return { subtitles: [] };

    const parsedBlocks = parseSRT(rawSrt);
    
    // تقسيم الملف إلى دفعات (مثلاً 150 سطر لكل دفعة لضمان السرعة وعدم انقطاع الاتصال)
    const batchSize = 150;
    let translatedBlocks = [];

    for (let i = 0; i < parsedBlocks.length; i += batchSize) {
        const batch = parsedBlocks.slice(i, i + batchSize);
        const translatedBatch = await translateBatchWithAI(batch);
        translatedBlocks = translatedBlocks.concat(translatedBatch);
    }

    const finalSrt = buildSRT(translatedBlocks);
    subCache.set(id, finalSrt);

    return {
        subtitles: [{
            id: `netflix-ai-${id}`,
            url: `${process.env.HOST_URL}/srt/${encodeURIComponent(id)}.srt`,
            lang: 'ara'
        }]
    };
});

// 6. تشغيل الخادم وتوفير رابط تحميل ملف الـ SRT المباشر لمشغل Stremio
const app = express();

// السماح لـ Stremio بالوصول للإضافة (CORS)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', '*');
    next();
});

// مسار تقديم ملف الترجمة المترجم بصيغة SRT
app.get('/srt/:id.srt', (req, res) => {
    const id = decodeURIComponent(req.params.id);
    const srtContent = subCache.get(id);

    if (!srtContent) {
        return res.status(404).send('Subtitle not found or expired');
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(srtContent);
});

// ربط واجهة Stremio
app.use('/', getRouter(builder.getInterface()));

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
    console.log(`الإضافة تعمل الآن على الرابط: http://localhost:${PORT}/manifest.json`);
});