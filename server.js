const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');

// 1. ضع مفتاح الذكاء الاصطناعي هنا أو اجعله يقرأه من إعدادات السيرفر البيئية (Environment Variables)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'ضع_مفتاح_الـ_Gemini_هنا';
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });

// 2. إعدادات الإضافة الأساسية
const manifest = {
    id: 'org.stremio.aiarabicsub.pure',
    version: '1.0.0',
    name: 'Netflix Arabic AI (Pure AI)',
    description: 'ترجمة عربية سينمائية واحترافية بالكامل عبر الذكاء الاصطناعي لـ Stremio',
    types: ['movie', 'series'],
    catalogs: [],
    resources: ['subtitles'],
    idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

// ذاكرة مؤقتة بسيطة (Cache) لكي لا يستهلك الذكاء الاصطناعي في كل مرة تفتح فيها نفس العمل
const subtitlesCache = {};

// دالة جلب اسم الفيلم أو المسلسل الحقيقي من رقم الـ IMDb
async function getMediaMetadata(id) {
    try {
        const parts = id.split(':');
        const imdbId = parts[0];
        const type = parts.length > 2 ? 'series' : 'movie';
        
        const response = await axios.get(`https://cinemeta-stremio.strem.fun/meta/${type}/${imdbId}.json`);
        const meta = response.data.meta;
        
        if (parts.length > 2) {
            const season = parts[1];
            const episode = parts[2];
            return `${meta.name} - Season ${season} Episode ${episode}`;
        }
        return `${meta.name} (${meta.year || ''})`;
    } catch (error) {
        console.error('فشل جلب اسم العمل:', error.message);
        return id;
    }
}

// دالة توليد الترجمة بالذكاء الاصطناعي بصيغة SRT صحيحة
async function generateAISubtitles(mediaTitle) {
    const prompt = `
    أنت مترجم سينمائي محترف ومختص بترجمة منصة Netflix العالمية.
    المطلوب: قم بتوليد ملف ترجمة كامل ومترابط بصيغة SRT باللغة العربية الفصحى للعمل التالي: "${mediaTitle}".
    
    شروط صارمة جداً:
    1. الصياغة يجب أن تكون سينمائية، طبيعية، وسلسة (ليست حرفية أو ركيكة).
    2. التزم تماماً بتنسيق ملفات الـ SRT القياسية (أرقام الأسطر، التوقيت بالشكل 00:00:00,000 --> 00:00:00,000، ثم النص تحته، وبينهما أسطر فارغة).
    3. اجعل مدة الترجمة تغطي الأحداث الافتراضية للعمل بشكل متناسق ومنطقي.
    4. أرجع ملف الـ SRT صافياً ومرتباً **فقط**، بدون أي كلام أو شرح أو مقدمات خارج كود الـ SRT.
    `;

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error('خطأ من الذكاء الاصطناعي:', error.message);
        return null;
    }
}

// معالج طلبات الترجمة من Stremio
builder.defineSubtitlesHandler(async function(args) {
    const { id } = args;
    console.log(`[Stremio Request] طلب ترجمة للـ ID: ${id}`);

    // التحقق هل الترجمة موجودة مسبقاً في الذاكرة المؤقتة (Cache)
    if (subtitlesCache[id]) {
        console.log(`[Cache Hit] تم استرجاع الترجمة المخزنة مسبقاً للعمل: ${id}`);
        return {
            subtitles: [{ id: `${id}-ai`, lang: 'ara', url: subtitlesCache[id] }]
        };
    }

    // جلب اسم الفيلم أو المسلسل
    const mediaTitle = await getMediaMetadata(id);
    console.log(`[AI Generation] جارٍ توليد الترجمة بالذكاء الاصطناعي لـ: ${mediaTitle}`);

    // توليد الترجمة
    const srtContent = await generateAISubtitles(mediaTitle);
    if (!srtContent) return { subtitles: [] };

    // تحويل النص المحفوظ إلى Data URL (بحيث يقرأه Stremio كملف SRT جاهز مباشرة)
    // أو يمكنك تخزينه كرابط مسار (Endpoint) على سيرفرك
    const base64Srt = Buffer.from(srtContent).toString('base64');
    const dataUrl = `data:text/plain;base64,${base64Srt}`;

    // حفظه في الذاكرة المؤقتة لكي لا يتكرر التوليد مستقبلاً
    subtitlesCache[id] = dataUrl;

    return {
        subtitles: [
            {
                id: `${id}-ai`,
                lang: 'ara',
                url: dataUrl
            }
        ]
    };
});

// تشغيل السيرفر على البورت المطلوب
const PORT = process.env.PORT || 7000;
serveHTTP(builder.interface, { port: PORT });
console.log(`Stremio AI Addon is running on port ${PORT}`);