import { SpeechClient } from '@google-cloud/speech';
import { Storage } from '@google-cloud/storage';
import path from 'path';
import {google} from "@google-cloud/speech/build/protos/protos";

const speechClient = new SpeechClient();
const storage = new Storage();

/**
 * 将 Google 的纳秒级时间格式化为标准 LRC 时间 [mm:ss.xx]
 */
function formatLrcTime(timeObj: google.protobuf.IDuration): string {
    const totalSeconds = Number(timeObj.seconds || 0);
    const nanos = timeObj.nanos || 0;

    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const centiseconds = Math.floor(nanos / 10000000); // 10,000,000 ns = 0.01 s

    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    const xx = String(centiseconds).padStart(2, '0');

    return `[${mm}:${ss}.${xx}]`;
}

/**
 * 将长音频上传至 GCS，调用最新的 STT 模型生成天然断句的单语 LRC
 */
export async function generateLrcFromAudio(
    localAudioPath: string,
    languageCode: string,
    bucketName: string
): Promise<string> {
    // 加时间戳防止多并发覆盖
    const uniqueFileName = `${Date.now()}_${path.basename(localAudioPath)}`;
    const gcsUri = `gs://${bucketName}/${uniqueFileName}`;

    try {
        // 1. 上传至 GCS
        console.log(`☁️  步骤 1/4: 上传临时音频至 GCS...`);
        await storage.bucket(bucketName).upload(localAudioPath, {
            destination: uniqueFileName,
        });

        // 2. 配置长语音识别参数
        console.log(`🤖 步骤 2/4: 发起 Google STT 识别请求 (${languageCode}, latest_long)...`);
        const audio = { uri: gcsUri };
        const config = {
            languageCode: languageCode,
            enableAutomaticPunctuation: true, // 核心机制：让 API 自动根据停顿补充标点并断句
            enableWordTimeOffsets: true,      // 核心机制：提取句首单词的时间戳
            model: 'latest_long',             // 专为超过数分钟的长音频优化的模型
            // 省略 encoding 和 sampleRateHertz，交给 Google 智能检测文件头
        };

        const request = { audio, config };
        const [operation] = await speechClient.longRunningRecognize(request);

        // 3. 轮询等待结果 (对于 10 分钟音频，大概需要等待 2~3 分钟)
        console.log(`⏳ 步骤 3/4: 云端处理中，请耐心等待...`);
        const [response] = await operation.promise();

        // 4. 解析结果并转换为 LRC 格式
        console.log(`📝 步骤 4/4: 解析结果，生成词级同步的单语 LRC...`);
        let lrcContent = '';

        const results = response.results || [];
        for (const result of results) {
            const alternative = result.alternatives?.[0];
            if (alternative && alternative.words && alternative.words.length > 0) {
                // 以第一个单词的开始时间作为这句 LRC 的时间戳
                const startTime = alternative.words[0].startTime;
                const transcript = alternative.transcript;

                if (startTime && transcript) {
                    const lrcTime = formatLrcTime(startTime);
                    lrcContent += `${lrcTime}${transcript.trim()}\n`;
                }
            }
        }

        if (!lrcContent.trim()) {
            throw new Error("识别结果为空，可能音频为静音或语言模型不匹配");
        }

        return lrcContent;

    } finally {
        // 5. 阅后即焚，清理战场避免产生持续的云存储费用
        console.log(`🧹 正在清理 GCS 临时文件...`);
        await storage.bucket(bucketName).file(uniqueFileName).delete().catch(() => {
            console.log(`⚠️  警告: GCS 临时文件删除失败，可稍后在云控制台手动清理: ${uniqueFileName}`);
        });
    }
}