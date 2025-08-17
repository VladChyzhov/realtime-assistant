const EventEmitter = require('events');
const OpenAI = require('openai');
const WebSocket = require('ws');

class OpenAIStream extends EventEmitter {
  constructor(model, apiKey, vadProcessor, options = {}) {
    super();
    
    this.model = model || 'gpt-4o-realtime-preview';
    this.apiKey = apiKey;
    this.vadProcessor = vadProcessor;
    this.options = {
      systemPrompt: options.systemPrompt || this.getDefaultSystemPrompt(),
      maxTokens: options.maxTokens || 150,
      temperature: options.temperature || 0.7,
      ...options
    };
    
    // OpenAI REST клиент (для резервной генерации текста)
    this.openai = new OpenAI({ apiKey: this.apiKey });

    // Realtime WebSocket
    this.ws = null;
    this.wsReady = false;
    
    // Состояние
    this.isStreaming = false;
    this.currentTranscript = '';
    this.currentResponse = '';
    this.currentResponseAccum = '';
    this.lastTranscriptTime = 0;
    this.lastResponseTime = 0;
    
    // Статистика
    this.stats = {
      totalChunks: 0,
      transcriptChunks: 0,
      responseChunks: 0,
      errors: 0,
      startTime: null,
      totalAudioBytes: 0,
      totalResponseTime: 0
    };
    
    // Буферы для оптимизации
    this.audioBuffer = [];
    this.transcriptBuffer = [];
    this.responseBuffer = [];
    
    // Таймеры для управления потоком
    this.streamingTimer = null;
    this.audioTimeout = null;
    this.autoCommitTimer = null;
    
    // Инициализация
    this.init();
  }

  getDefaultSystemPrompt() {
    return `Ты — мой AI-помощник для живых собеседований и звонков.

Твоя задача:
1. Слушать речь собеседника и транскрибировать её в реальном времени
2. Анализировать содержание и контекст разговора
3. Генерировать 3 варианта ответа на разных языках

Формат ответов:
RU: [Полный, содержательный ответ на русском языке]
EN: [A full, detailed answer in English]
SV: [Ett fullständigt svar på svenska]

Требования:
- Отвечай кратко, но по существу
- Учитывай контекст предыдущих фраз
- Будь полезным, дружелюбным и профессиональным
- Адаптируй стиль под тип разговора (деловой, дружеский, формальный)
- Предлагай конкретные действия или рекомендации когда уместно`;
  }

  async init() {
    try {
      console.log('🔌 Инициализация OpenAI Realtime потока...');
      
      if (!this.apiKey) {
        throw new Error('OPENAI_API_KEY не установлен');
      }
      
      // Подключаем VAD процессор
      this.setupVADIntegration();
      
      // Устанавливаем WebSocket соединение с Realtime API
      await this.connectRealtime();

      console.log('✅ OpenAI поток инициализирован');
      this.emit('ready');
      
    } catch (error) {
      console.error('❌ Ошибка инициализации OpenAI потока:', error);
      this.emit('error', error);
      throw error;
    }
  }

  async connectRealtime() {
    return new Promise((resolve, reject) => {
      try {
        const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`;
        const headers = {
          Authorization: `Bearer ${this.apiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        };
        this.ws = new WebSocket(url, { headers });

        this.ws.on('open', () => {
          this.wsReady = true;
          console.log('🔗 Realtime WS подключен');
          resolve();
        });

        this.ws.on('message', (data) => {
          try {
            const text = data.toString();
            const event = JSON.parse(text);
            try { console.log('🔔 Realtime event:', event.type); } catch {}
            this.handleRealtimeEvent(event);
          } catch (err) {
            // Игнорируем бинарные фреймы
          }
        });

        this.ws.on('close', () => {
          this.wsReady = false;
          console.log('🔌 Realtime WS закрыт');
        });

        this.ws.on('error', (err) => {
          this.wsReady = false;
          console.error('❌ WS ошибка:', err);
          this.emit('error', err);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  setupVADIntegration() {
    if (this.vadProcessor) {
      // Слушаем события VAD
      this.vadProcessor.on('speech-start', (data) => {
        console.log('🎙️ VAD: Начало речи, активация потока');
        this.activateStream();
      });
      
      this.vadProcessor.on('speech-end', (data) => {
        console.log('🔇 VAD: Конец речи, деактивация потока');
        this.deactivateStream();
      });
      
      // Слушаем уровень звука для оптимизации
      this.vadProcessor.on('audio-level', (level) => {
        this.handleAudioLevel(level);
      });
    }
  }

  activateStream() {
    if (!this.isStreaming) {
      this.isStreaming = true;
      console.log('🎙️ Поток активирован');
      this.emit('stream-activated');
      
      // Устанавливаем таймер для автоматической деактивации
      this.streamingTimer = setTimeout(() => {
        if (this.isStreaming) {
          console.log('⏰ Таймаут потока, деактивация');
          this.deactivateStream();
        }
      }, parseInt(process.env.STREAMING_TIMEOUT) || 5000);

      // Запускаем авто-коммит/запрос ответа, если ещё не запущен
      if (!this.autoCommitTimer) {
        this.scheduleAutoCommit();
      }
    }
  }

  deactivateStream() {
    if (this.isStreaming) {
      this.isStreaming = false;
      console.log('🔇 Поток деактивирован');
      this.emit('stream-deactivated');
      
      // Очищаем таймеры
      if (this.streamingTimer) {
        clearTimeout(this.streamingTimer);
        this.streamingTimer = null;
      }
      
      if (this.audioTimeout) {
        clearTimeout(this.audioTimeout);
        this.audioTimeout = null;
      }

      if (this.autoCommitTimer) {
        clearTimeout(this.autoCommitTimer);
        this.autoCommitTimer = null;
      }
      
      // Обрабатываем накопленные данные
      this.processBufferedData();
    }
  }

  async sendAudioData(audioData) {
    if (!this.isStreaming || !audioData) {
      return;
    }
    
    try {
      // Добавляем аудио данные в буфер
      this.audioBuffer.push(audioData);
      
      // Обновляем статистику
      this.stats.totalChunks++;
      this.stats.totalAudioBytes += audioData.length || 0;
      
      // Устанавливаем таймер для обработки накопленных данных
      if (this.audioTimeout) {
        clearTimeout(this.audioTimeout);
      }
      
      this.audioTimeout = setTimeout(() => {
        this.processAudioBuffer();
      }, 80); // немного меньше для снижения задержки
      
    } catch (error) {
      console.error('❌ Ошибка обработки аудио данных:', error);
      this.stats.errors++;
    }
  }

  async processAudioBuffer() {
    if (this.audioBuffer.length === 0) {
      return;
    }
    
    try {
      // Объединяем накопленные аудио данные
      const combinedAudio = this.combineAudioChunks(this.audioBuffer);

      // Очищаем буфер
      this.audioBuffer = [];

      // Отправляем чанки в Realtime WS как input_audio_buffer.append
      for (const chunk of combinedAudio) {
        if (!chunk) continue;
        // Ожидаем base64 PCM16 строки
        if (typeof chunk === 'string') {
          this.sendRealtimeEvent({ type: 'input_audio_buffer.append', audio: chunk });
        }
      }
      
    } catch (error) {
      console.error('❌ Ошибка обработки аудио буфера:', error);
      this.stats.errors++;
    }
  }

  combineAudioChunks(chunks) {
    try {
      // Простое объединение аудио чанков
      // В реальном приложении здесь может быть более сложная логика
      return chunks;
    } catch (error) {
      console.error('❌ Ошибка объединения аудио чанков:', error);
      return [];
    }
  }

  sendRealtimeEvent(event) {
    if (this.ws && this.wsReady) {
      try {
        this.ws.send(JSON.stringify(event));
      } catch (error) {
        console.error('❌ Ошибка отправки WS события:', error);
      }
    }
  }

  handleOpenAIResponse(result) {
    try {
      if (result.text) {
        // Обрабатываем транскрипт
        this.handleTranscript(result.text);
        
        // Генерируем ответ на основе транскрипта
        this.generateResponse(result.text);
      }
      
    } catch (error) {
      console.error('❌ Ошибка обработки ответа OpenAI:', error);
      this.stats.errors++;
    }
  }

  handleTranscript(text) {
    this.currentTranscript = text;
    this.lastTranscriptTime = Date.now();
    
    // Эмитим транскрипт
    this.emit('transcript', { text, timestamp: Date.now() });
    
    // Обновляем статистику
    this.stats.transcriptChunks++;
    
    console.log('📝 Транскрипт:', text);
  }

  async generateResponse(transcript) {
    try {
      console.log('🤖 Генерация ответа на основе транскрипта...');
      // Через Realtime инициируем создание ответа
      const instructions = `${this.options.systemPrompt}

Формат вывода строго:
TRANSCRIPT: <транскрипт речи>
RU: <ответ на русском>
EN: <answer in English>
SV: <svar på svenska>`;

      this.currentResponseAccum = '';
      this.requestResponse(instructions);
      
    } catch (error) {
      console.error('❌ Ошибка генерации ответа:', error);
      this.stats.errors++;
      this.emit('error', error);
    }
  }

  handleResponse(text) {
    this.currentResponse = text;
    this.lastResponseTime = Date.now();
    
    // Парсим многоязычный ответ
    const parsedResponse = this.parseMultilingualResponse(text);
    const transcript = this.parseTranscript(text);
    if (transcript) {
      this.handleTranscript(transcript);
    }
    
    // Эмитим ответ
    this.emit('response', { 
      text, 
      parsed: parsedResponse, 
      timestamp: Date.now() 
    });
    
    // Обновляем статистику
    this.stats.responseChunks++;
    this.stats.totalResponseTime += Date.now() - this.stats.startTime;
    
    console.log('💬 Ответ сгенерирован:', parsedResponse);
  }

  parseMultilingualResponse(text) {
    try {
      const response = {
        RU: '',
        EN: '',
        SV: ''
      };
      
      // Парсинг по языковым маркерам
      const lines = text.split('\n');
      
      for (const line of lines) {
        if (line.includes('RU:') || line.includes('🇷🇺')) {
          response.RU = line.replace(/^(RU:|🇷🇺\s*)/, '').trim();
        } else if (line.includes('EN:') || line.includes('🇺🇸')) {
          response.EN = line.replace(/^(EN:|🇺🇸\s*)/, '').trim();
        } else if (line.includes('SV:') || line.includes('🇸🇪')) {
          response.SV = line.replace(/^(SV:|🇸🇪\s*)/, '').trim();
        }
      }
      
      // Если не удалось распарсить, используем весь текст
      if (!response.RU && !response.EN && !response.SV) {
        response.RU = text;
        response.EN = text;
        response.SV = text;
      }
      
      return response;
      
    } catch (error) {
      console.error('❌ Ошибка парсинга многоязычного ответа:', error);
      return { RU: text, EN: text, SV: text };
    }
  }

  parseTranscript(text) {
    try {
      const match = text.match(/TRANSCRIPT:\s*(.*)/i);
      return match ? match[1].trim() : '';
    } catch {
      return '';
    }
  }

  handleAudioLevel(level) {
    // Оптимизация на основе уровня звука
    if (level > 0.01) {
      // Высокий уровень звука - активируем поток
      this.activateStream();
    }
  }

  processBufferedData() {
    // Обрабатываем накопленные данные при деактивации потока
    if (this.audioBuffer.length > 0) {
      this.processAudioBuffer();
    }
  }

  switchModel(newModel) {
    if (this.model !== newModel) {
      this.model = newModel;
      console.log('🔄 Модель переключена на:', newModel);
      
      // Обновляем системный промпт
      this.options.systemPrompt = this.getDefaultSystemPrompt();
      
      this.emit('model-changed', newModel);
    }
  }

  getStats() {
    const uptime = this.stats.startTime ? Date.now() - this.stats.startTime : 0;
    const avgResponseTime = this.stats.responseChunks > 0 ? 
      this.stats.totalResponseTime / this.stats.responseChunks : 0;
    
    return {
      ...this.stats,
      uptime: Math.round(uptime),
      averageResponseTime: Math.round(avgResponseTime),
      currentModel: this.model,
      isStreaming: this.isStreaming
    };
  }

  close() {
    try {
      console.log('🛑 Закрытие OpenAI потока...');
      
      // Очищаем таймеры
      if (this.streamingTimer) {
        clearTimeout(this.streamingTimer);
        this.streamingTimer = null;
      }
      
      if (this.audioTimeout) {
        clearTimeout(this.audioTimeout);
        this.audioTimeout = null;
      }
      if (this.autoCommitTimer) {
        clearTimeout(this.autoCommitTimer);
        this.autoCommitTimer = null;
      }
      
      this.isStreaming = false;
      if (this.ws) {
        try { this.ws.close(); } catch {}
        this.ws = null;
      }
      
      console.log('✅ OpenAI поток закрыт');
      
    } catch (error) {
      console.error('❌ Ошибка закрытия OpenAI потока:', error);
      throw error;
    }
  }

  // Публичный метод: прием PCM16 base64 от renderer
  ingestBase64Pcm16(base64Pcm16) {
    if (!base64Pcm16) return;
    // Добавляем в буфер как строку
    this.audioBuffer.push(base64Pcm16);
    if (this.isStreaming) {
      if (this.audioTimeout) clearTimeout(this.audioTimeout);
      this.audioTimeout = setTimeout(() => this.processAudioBuffer(), 50);
    }
  }

  // Публичный метод: реакция на VAD события
  handleVADEvent(type) {
    if (type === 'speech-start') {
      this.activateStream();
      // Начинаем новый сегмент – предыдущий не коммитим до окончания
    } else if (type === 'speech-end') {
      // Завершаем сегмент и запрашиваем ответ
      this.deactivateStream();
      this.generateResponse(this.currentTranscript || '');
    }
  }

  handleRealtimeEvent(event) {
    if (!event || !event.type) return;
    try {
      switch (event.type) {
        case 'response.delta': {
          // Универсальный стриминг текста
          const delta = event.delta || event.output_text || event.text || '';
          if (typeof delta === 'string' && delta.length > 0) {
            this.currentResponseAccum += delta;
            // Можно эмитить частичный ответ при необходимости
          }
          break;
        }
        case 'response.completed': {
          const fullText = this.currentResponseAccum || '';
          this.currentResponseAccum = '';
          if (fullText) {
            this.handleResponse(fullText);
          }
          break;
        }
        case 'error': {
          this.emit('error', new Error(event.error?.message || 'Realtime error'));
          break;
        }
        default:
          break;
      }
    } catch (error) {
      console.error('❌ Ошибка обработки Realtime события:', error);
    }
  }

  scheduleAutoCommit() {
    if (this.autoCommitTimer) return;
    this.autoCommitTimer = setTimeout(async () => {
      this.autoCommitTimer = null;
      try {
        if (this.audioBuffer.length > 0) {
          await this.processAudioBuffer();
          this.requestResponse(this.options.systemPrompt);
        }
      } catch (e) {
        console.error('❌ Авто-коммит ошибка:', e);
      } finally {
        if (this.isStreaming) {
          this.scheduleAutoCommit();
        }
      }
    }, parseInt(process.env.REALTIME_AUTOCOMMIT_MS) || 3000);
  }

  requestResponse(instructions) {
    this.sendRealtimeEvent({ type: 'input_audio_buffer.commit' });
    this.sendRealtimeEvent({ type: 'response.create', response: { instructions } });
  }
}

// Функция для создания OpenAI потока
function createOpenAIStream(model, apiKey, vadProcessor, options = {}) {
  return new OpenAIStream(model, apiKey, vadProcessor, options);
}

module.exports = {
  OpenAIStream,
  createOpenAIStream
};
