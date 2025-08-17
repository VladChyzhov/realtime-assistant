const EventEmitter = require('events');

class VADProcessor extends EventEmitter {
  constructor(audioStream, options = {}) {
    super();
    this.audioStream = audioStream;
    this.isRunning = false;
    
    // Настройки VAD с оптимизацией для системного звука
    this.speechThreshold = options.speechThreshold || 0.008;
    this.silenceThreshold = options.silenceThreshold || 0.003;
    this.silenceFrames = options.silenceFrames || 15;
    this.frameSize = options.frameSize || 512;
    this.sampleRate = options.sampleRate || 16000;
    
    // Дополнительные настройки для системного звука
    this.energyThreshold = options.energyThreshold || 0.001;
    this.zeroCrossingThreshold = options.zeroCrossingThreshold || 0.1;
    this.spectralCentroidThreshold = options.spectralCentroidThreshold || 0.5;
    
    // Состояние
    this.isSpeaking = false;
    this.silenceCounter = 0;
    this.frameCount = 0;
    this.lastSpeechTime = 0;
    
    // Статистика
    this.stats = {
      totalFrames: 0,
      speechFrames: 0,
      silenceFrames: 0,
      averageLevel: 0,
      speechSegments: 0,
      totalSpeechTime: 0
    };
    
    // Буферы для анализа
    this.audioBuffer = new Float32Array(this.frameSize);
    this.bufferIndex = 0;
    
    this.init();
  }

  async init() {
    try {
      console.log('🎤 Инициализация VAD процессора...');
      
      // В Node.js среде создаем заглушку для тестирования
      console.log('⚠️ Web API недоступны в Node.js, используем заглушку');
      
      console.log('✅ VAD процессор инициализирован');
      this.emit('ready');
      
    } catch (error) {
      console.error('❌ Ошибка инициализации VAD:', error);
      this.emit('error', error);
      throw error;
    }
  }

  processAudioFrame(event) {
    // Заглушка для Node.js среды
    console.log('🎤 Обработка аудио фрейма (заглушка)');
  }

  analyzeAudioFrame() {
    // Заглушка для Node.js среды
    return {
      rms: 0.1,
      energy: 0.1,
      zeroCrossingRate: 0.1,
      spectralCentroid: 0.5
    };
  }

  calculateSpectralCentroid() {
    // Заглушка для Node.js среды
    return 0.5;
  }

  detectSpeech(rms, energy, zeroCrossingRate, spectralCentroid) {
    // Простая логика детекции речи для тестирования
    const isSpeech = rms > this.speechThreshold && energy > this.energyThreshold;
    return isSpeech;
  }

  handleSpeechDetection(isSpeech, rms) {
    // Заглушка для Node.js среды
    if (isSpeech) {
      console.log('🎙️ Речь обнаружена (заглушка)');
      this.emit('speech-start', { level: rms, timestamp: Date.now() });
    } else {
      console.log('🔇 Тишина (заглушка)');
      this.emit('speech-end', { level: rms, timestamp: Date.now() });
    }
  }

  setThresholds(speechThreshold, silenceThreshold) {
    this.speechThreshold = speechThreshold;
    this.silenceThreshold = silenceThreshold;
    console.log(`🎤 Пороги VAD обновлены: speech=${speechThreshold}, silence=${silenceThreshold}`);
  }

  setSensitivity(sensitivity) {
    // Заглушка для Node.js среды
    console.log(`🎤 Чувствительность VAD установлена: ${sensitivity}`);
  }

  getStats() {
    const uptime = this.stats.startTime ? Date.now() - this.stats.startTime : 0;
    return {
      ...this.stats,
      uptime: Math.round(uptime),
      isRunning: this.isRunning
    };
  }

  pause() {
    if (this.isRunning) {
      this.isRunning = false;
      console.log('⏸️ VAD процессор приостановлен');
      this.emit('paused');
    }
  }

  resume() {
    if (!this.isRunning) {
      this.isRunning = true;
      console.log('▶️ VAD процессор возобновлен');
      this.emit('resumed');
    }
  }

  close() {
    try {
      console.log('🛑 Закрытие VAD процессора...');
      this.isRunning = false;
      console.log('✅ VAD процессор закрыт');
      this.emit('closed');
    } catch (error) {
      console.error('❌ Ошибка закрытия VAD процессора:', error);
      throw error;
    }
  }
}

// Функция для создания VAD процессора
function createVadProcessor(audioStream, options = {}) {
  try {
    console.log('🎤 Создание VAD процессора...');
    const vad = new VADProcessor(audioStream, options);
    return vad;
  } catch (error) {
    console.error('❌ Ошибка создания VAD процессора:', error);
    throw error;
  }
}

module.exports = {
  VADProcessor,
  createVadProcessor
};
