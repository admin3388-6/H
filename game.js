/**
 * Marine Ecosystem 2D Prototype - Vertical Cross-Section
 * High Performance Mobile-First Canvas 2D Engine
 */

(function () {
  'use strict';

  // مسجل الأحداث والأخطاء للتشخيص
  const GameLogger = {
    KEY: 'marine_game_logs',
    log(cat, level, msg, det = null) {
      try {
        const raw = localStorage
          .getItem(this.KEY);
        const list = raw ?
          JSON.parse(raw) : [];
        list.push({
          t: new Date().toISOString(),
          cat, level, msg, det
        });
        if (list.length > 250) {
          list.shift();
        }
        localStorage.setItem(
          this.KEY,
          JSON.stringify(list)
        );
      } catch (_) {}
    }
  };
  window.GameLogger = GameLogger;

  // رصد الأخطاء غير المعالجة
  window.addEventListener(
    'error', (e) => {
      GameLogger.log('ERROR', 'ERR',
        e.message, {
          file: e.filename,
          line: e.lineno
        });
    }
  );

  // =========================================================================
  // 1. CONFIGURATION & CONSTANTS
  // =========================================================================
  const WORLD = {
    WIDTH: 12000,         // عرض العالم الموسّع: الشاطئ عند x≈10500 والجدار عند x≈4500
    HEIGHT: 70000,        // توسيع الخريطة فيزيائياً لعمق 11 كم بمقياس دقيق
    WATER_Y: 400,         // منسوب سطح البحر
    PIXELS_PER_METER: 6,  // 6 بكسل/متر — مقياس عالمي موحّد (تضاريس/سرعة/عمق/كاميرا/صوت)
    SHORE_X: 10500,       // بداية الشاطئ والكثبان الرملية
    WALL_X: 4500,         // الجدار الصخري السحيق — عنده يبلغ العمق 100م
    CHUNK: 800,           // حجم Chunk لنظام الـStreaming (800×800 بكسل عالم)
  };

  // مولد أرقام شبه عشوائي حتمي (Deterministic PRNG) لتفادي تغير العالم عشوائيًا
  class DeterministicRNG {
    constructor(seed = 987654321) {
      this.state = seed >>> 0;
    }
    next() {
      this.state = (1664525 * this.state + 1013904223) >>> 0;
      return this.state / 4294967296;
    }
    range(min, max) {
      return min + this.next() * (max - min);
    }
  }

  // =========================================================================
  // 1.5 QUALITY PRESETS — مستويات جودة: عادية / عالية / قصوى (تُطبَّق حياً)
  // =========================================================================
  const QUALITY_PRESETS = {
    normal: { stars: 22, snow: 14, rainDrops: 42, flakes: 30, subRays: 80, diverRays: 48, fauna: 24, subMotes: 20, diverMotes: 16, surfaceSparkle: false },
    high:   { stars: 45, snow: 28, rainDrops: 70, flakes: 50, subRays: 120, diverRays: 72, fauna: 34, subMotes: 32, diverMotes: 24, surfaceSparkle: true },
    max:    { stars: 70, snow: 42, rainDrops: 100, flakes: 70, subRays: 160, diverRays: 96, fauna: 44, subMotes: 44, diverMotes: 32, surfaceSparkle: true }
  };
  const Quality = {
    level: 'high',
    q: QUALITY_PRESETS.high,
    load() {
      try {
        const v = localStorage.getItem('marine_quality');
        if (v && QUALITY_PRESETS[v]) this.level = v;
      } catch (_) {}
      this.q = QUALITY_PRESETS[this.level];
    },
    set(level) {
      if (!QUALITY_PRESETS[level]) return;
      this.level = level;
      this.q = QUALITY_PRESETS[level];
      try { localStorage.setItem('marine_quality', level); } catch (_) {}
    }
  };
  Quality.load();

  // =========================================================================
  // 2. VIRTUAL JOYSTICK 360° & INPUT ENGINE
  // =========================================================================
  class VirtualJoystick {
    constructor(zoneEl, stickEl) {
      this.zone = zoneEl;
      this.stick = stickEl;
      this.active = false;
      this.pointerId = null;
      this.startX = 0;
      this.startY = 0;
      this.radius = 50;
      this.dirX = 0;
      this.dirY = 0;
      this.force = 0;

      this.initEvents();
    }

    initEvents() {
      if (!this.zone || !this.stick) return;

      this.zone.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.zone.setPointerCapture(e.pointerId);
        this.pointerId = e.pointerId;
        this.active = true;

        const rect = this.zone.getBoundingClientRect();
        this.startX = rect.left + rect.width * 0.5;
        this.startY = rect.top + rect.height * 0.5;
        this.handleMove(e.clientX, e.clientY);
      });

      this.zone.addEventListener('pointermove', (e) => {
        if (!this.active || e.pointerId !== this.pointerId) return;
        this.handleMove(e.clientX, e.clientY);
      });

      const onEnd = (e) => {
        if (e.pointerId !== this.pointerId) return;
        this.reset();
        try { this.zone.releasePointerCapture(e.pointerId); } catch (_) {}
      };

      this.zone.addEventListener('pointerup', onEnd);
      this.zone.addEventListener('pointercancel', onEnd);
    }

    handleMove(clientX, clientY) {
      const dx = clientX - this.startX;
      const dy = clientY - this.startY;
      const dist = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const clampedDist = Math.min(dist, this.radius);

      this.dirX = Math.cos(angle);
      this.dirY = Math.sin(angle);
      this.force = clampedDist / this.radius;

      const px = this.dirX * clampedDist;
      const py = this.dirY * clampedDist;
      this.stick.style.transform = `translate(${px}px, ${py}px)`;
    }

    reset() {
      this.active = false;
      this.pointerId = null;
      this.dirX = 0;
      this.dirY = 0;
      this.force = 0;
      this.stick.style.transform = 'translate(0px, 0px)';
    }
  }

  // =========================================================================
  // 2.2 VERTICAL SUBMARINE THROTTLE CONTROLLER (عتلة سرعة لمسية انسيابية)
  // =========================================================================
  class SubmarineThrottle {
    constructor(panelEl, knobEl, onLevelChange) {
      this.panel = panelEl;
      this.knob = knobEl;
      this.slotCut = panelEl ? panelEl.querySelector('.throttle-slot-cut') : null;
      this.onLevelChange = onLevelChange;
      this.level = 0; // -1 (REV), 0 (IDLE), 1, 2, 3, 4
      this.pointerId = null;
      this.active = false;
      this.initEvents();
      this.updateVisuals();
    }

    initEvents() {
      if (!this.panel || !this.knob) return;

      const handlePointer = (clientY) => {
        const targetEl = this.slotCut || this.panel;
        const rect = targetEl.getBoundingClientRect();
        const y = clientY - rect.top;
        const h = Math.max(1, rect.height);
        const norm = Math.max(0, Math.min(1, y / h));

        let newLevel = 0;
        if (norm <= 0.16) newLevel = 4;
        else if (norm <= 0.33) newLevel = 3;
        else if (norm <= 0.50) newLevel = 2;
        else if (norm <= 0.68) newLevel = 1;
        else if (norm <= 0.85) newLevel = 0;
        else newLevel = -1;

        if (newLevel !== this.level) {
          this.level = newLevel;
          this.updateVisuals();
          if (this.onLevelChange) this.onLevelChange(this.level);
        }
      };

      this.panel.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.active = true;
        this.pointerId = e.pointerId;
        try { this.panel.setPointerCapture(e.pointerId); } catch (_) {}
        handlePointer(e.clientY);
      });

      this.panel.addEventListener('pointermove', (e) => {
        if (!this.active || e.pointerId !== this.pointerId) return;
        handlePointer(e.clientY);
      });

      const onEnd = (e) => {
        if (e.pointerId !== this.pointerId) return;
        this.active = false;
        this.pointerId = null;
        try { this.panel.releasePointerCapture(e.pointerId); } catch (_) {}
      };

      this.panel.addEventListener('pointerup', onEnd);
      this.panel.addEventListener('pointercancel', onEnd);
    }

    setLevel(lvl) {
      this.level = Math.max(-1, Math.min(4, lvl));
      this.updateVisuals();
      if (this.onLevelChange) this.onLevelChange(this.level);
    }

    updateVisuals() {
      if (!this.knob) return;
      const leverYMap = { '4': 2, '3': 22, '2': 42, '1': 62, '0': 82, '-1': 102 };
      const yPos = leverYMap[String(this.level)] !== undefined ? leverYMap[String(this.level)] : 82;
      this.knob.style.transform = `translateY(${yPos}px)`;

      if (this.panel) {
        const leds = this.panel.querySelectorAll('.led-block');
        const activeCountMap = { '-1': 1, '0': 2, '1': 3, '2': 4, '3': 5, '4': 6 };
        const activeCount = activeCountMap[String(this.level)] || 2;
        leds.forEach((led) => {
          const idx = parseInt(led.getAttribute('data-idx'), 10);
          led.classList.toggle('active', idx < activeCount);
        });
      }
    }
  }

  class InputEngine {
    constructor(canvas, camera) {
      this.canvas = canvas;
      this.camera = camera;
      // تم استبداله: حذف متغيرات السحب الحر والقصور الذاتي
      this.speedMultiplier = 1;
      this.jumpRequested = false;

      // تهيئة عصا التحكم 360° وزر القفز للهواتف
      const jZone = document.getElementById('joystick-zone');
      const jStick = document.getElementById('joystick-stick');
      this.joystick = new VirtualJoystick(jZone, jStick);

      // تهيئة عتلة التحكم الرأسي بالسرعة للغواصة
      const tPanel = document.getElementById('sub-throttle');
      const tKnob = document.getElementById('throttle-knob');
      this.throttle = new SubmarineThrottle(tPanel, tKnob, (lvl) => {
        this.subThrottleLevel = lvl;
      });
      this.subThrottleLevel = 0;

      const btnJump = document.getElementById('btn-jump');
      if (btnJump) {
        btnJump.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          try { btnJump.setPointerCapture(e.pointerId); } catch (_) {}
          this.jumpRequested = true;
        });
        const onJumpRelease = (e) => {
          this.jumpRequested = false;
          try { btnJump.releasePointerCapture(e.pointerId); } catch (_) {}
        };
        btnJump.addEventListener('pointerup', onJumpRelease);
        btnJump.addEventListener('pointercancel', onJumpRelease);
      }

      this.initEvents();
    }

    initEvents() {
      // تم استبداله: حذف معالجات السحب الحر للشاشة
      this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    update(dt) {
      // تم استبداله: حذف منطق القصور الذاتي للسحب الحر
    }
  }
  // =========================================================================
  // 2.5 ENTITIES: WOODEN DOCK, FISHERMAN, SUBMARINE
  // =========================================================================
  class WoodenDock {
    constructor(terrain) {
      this.terrain = terrain;
      this.deckY = WORLD.WATER_Y - 26; // 374px
      this.endX = WORLD.SHORE_X + 70;  // مثبت بدقة على رمال الشاطئ

      // ربط المنحدر ديناميكياً بنهاية الصخور وشاطئ البحر
      const rockEnd = terrain.rockBarrier ? terrain.rockBarrier.endX : 9350;
      this.rampStartX = rockEnd + 30;           // يبدأ بعد الصخور بـ 30px
      this.startX = this.rampStartX + 100;     // امتداد الرصيف الأفقي
      this.rampBottomY = WORLD.WATER_Y + 34;   // مغمور بعمق كافٍ في الماء

      this.stilts = [];
      for (let sx = this.startX + 40; sx < this.endX - 25; sx += 65) {
        this.stilts.push(sx);
      }
    }

    getSurfaceY(x) {
      if (x >= this.startX && x <= this.endX) {
        return this.deckY;
      }
      if (x >= this.rampStartX && x < this.startX) {
        const t = (x - this.rampStartX) / (this.startX - this.rampStartX);
        return this.rampBottomY + (this.deckY - this.rampBottomY) * t;
      }
      return null;
    }

    draw(ctx) {
      ctx.save();
      
      // 1. الأعمدة الخشبية الداعمة (خشب طبيعي، بدون طحالب خضراء)
      for (const sx of this.stilts) {
        const bottomY = this.terrain.getHeightAt(sx);
        
        const stiltGrad = ctx.createLinearGradient(sx - 5, 0, sx + 5, 0);
        stiltGrad.addColorStop(0.0, '#4a3320');
        stiltGrad.addColorStop(0.5, '#6b4a31');
        stiltGrad.addColorStop(1.0, '#362314');
        
        ctx.fillStyle = stiltGrad;
        ctx.fillRect(sx - 5, this.deckY + 4, 10, bottomY - (this.deckY + 4));
        
        // خطوط خشبية طولية خفيفة جداً للواقعية
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx - 2, this.deckY + 4); ctx.lineTo(sx - 2, bottomY);
        ctx.moveTo(sx + 2, this.deckY + 4); ctx.lineTo(sx + 2, bottomY);
        ctx.stroke();
      }

      // 2. المنصة الخشبية المائلة (تصميم بحري واقعي متين)
      // أ. أعمدة دعم خشبية مغمورة تمتد من المنحدر إلى قاع البحر
      const rampPillars = [this.rampStartX + 28, this.rampStartX + 68];
      for (const px of rampPillars) {
        const pyTop = this.getSurfaceY(px);
        const pyBottom = this.terrain.getHeightAt(px);
        const pGrad = ctx.createLinearGradient(px - 4, 0, px + 4, 0);
        pGrad.addColorStop(0.0, '#4a3320');
        pGrad.addColorStop(0.5, '#6b4a31');
        pGrad.addColorStop(1.0, '#362314');
        ctx.fillStyle = pGrad;
        ctx.fillRect(px - 4, pyTop + 3, 8, pyBottom - (pyTop + 3));
      }

      ctx.save();
      // ب. عارضة الأساس السفلية الداكنة
      ctx.fillStyle = '#422a18';
      ctx.beginPath();
      ctx.moveTo(this.startX, this.deckY + 4);
      ctx.lineTo(this.rampStartX, this.rampBottomY + 4);
      ctx.lineTo(this.rampStartX, this.rampBottomY + 9);
      ctx.lineTo(this.startX, this.deckY + 9);
      ctx.closePath();
      ctx.fill();

      // ج. سطح الألواح الخشبية المتينة بتدرج لوني
      const rampDeckGrad = ctx.createLinearGradient(this.startX, this.deckY, this.rampStartX, this.rampBottomY);
      rampDeckGrad.addColorStop(0.0, '#8c6242');
      rampDeckGrad.addColorStop(0.5, '#7a5336');
      rampDeckGrad.addColorStop(1.0, '#5a3d26');
      ctx.fillStyle = rampDeckGrad;
      ctx.beginPath();
      ctx.moveTo(this.startX, this.deckY);
      ctx.lineTo(this.rampStartX, this.rampBottomY);
      ctx.lineTo(this.rampStartX, this.rampBottomY + 4);
      ctx.lineTo(this.startX, this.deckY + 4);
      ctx.closePath();
      ctx.fill();

      // د. درجات وعوارض خشبية مانعة للانزلاق (Cleats)
      for (let rx = this.rampStartX + 12; rx < this.startX - 6; rx += 13) {
        const ry = this.getSurfaceY(rx);
        ctx.fillStyle = '#3a2414';
        ctx.fillRect(rx - 2, ry - 2, 4, 3);
        ctx.fillStyle = '#9e724e';
        ctx.fillRect(rx - 2, ry - 3, 4, 1);
      }
      ctx.restore();

      // 3. عارضة الدعم الأفقية (خشبية طبيعية وليست كتلة سوداء)
      ctx.fillStyle = '#422a18';
      ctx.fillRect(this.startX, this.deckY + 6, this.endX - this.startX, 5);

      // 4. الألواح الخشبية الطويلة (السطح)
      // رسم 3 ألواح أفقية طويلة تمتد على طول الرصيف بدلاً من المربعات
      const plankColors = ['#8c6242', '#7a5336', '#855c3d'];
      let currentY = this.deckY;

      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = plankColors[i];
        ctx.fillRect(this.startX, currentY, this.endX - this.startX, 2.5);
        currentY += 2.5;
        
        // فاصل بسيط وناعم بين الألواح
        if (i < 2) {
          ctx.fillStyle = 'rgba(20, 10, 5, 0.4)';
          ctx.fillRect(this.startX, currentY, this.endX - this.startX, 1);
          currentY += 1;
        }
      }

      // 5. وتد ربط القوارب (بسيط ونظيف بدون تعقيد)
      ctx.fillStyle = '#3a2618';
      ctx.fillRect(this.startX + 30, this.deckY - 6, 4, 6);
      ctx.fillRect(this.startX + 28, this.deckY - 8, 8, 3);

      ctx.restore();
    }
  }

  class WoodenShop {
    constructor(dock) {
      this.dock = dock;
      this.x = 10430; // في يمين الرصيف الخشبي بالقرب من الشاطئ
      this.y = dock.deckY;
      this.animTime = 0;
    }

    update(dt) {
      this.animTime += dt;
    }

    draw(ctx) {
      ctx.save();
      this.drawStructure(ctx);
      this.drawOldFisherman(ctx);
      this.drawCounter(ctx);
      this.drawSign(ctx);
      ctx.restore();
    }

    drawStructure(ctx) {
      const { x, y } = this;
      // الجدار الخلفي للمتجر
      ctx.fillStyle = '#3d2817';
      ctx.fillRect(x - 40, y - 64, 80, 44);

      // أعمدة التثبيت الخشبية الجانبية
      const postGrad = ctx.createLinearGradient(x - 42, 0, x - 34, 0);
      postGrad.addColorStop(0.0, '#4a3320');
      postGrad.addColorStop(0.5, '#6b4a31');
      postGrad.addColorStop(1.0, '#362314');
      ctx.fillStyle = postGrad;
      ctx.fillRect(x - 42, y - 72, 8, 72);
      ctx.fillRect(x + 34, y - 72, 8, 72);

      // سقف ومظلة المتجر الخشبية المائلة
      ctx.fillStyle = '#2b1b10';
      ctx.beginPath();
      ctx.moveTo(x - 48, y - 68);
      ctx.lineTo(x + 48, y - 68);
      ctx.lineTo(x + 44, y - 76);
      ctx.lineTo(x - 44, y - 76);
      ctx.closePath();
      ctx.fill();

      // ألواح السقف المتراكبة
      ctx.fillStyle = '#5c3a21';
      ctx.fillRect(x - 46, y - 72, 92, 5);
      ctx.fillStyle = '#7a4f2d';
      ctx.fillRect(x - 44, y - 75, 88, 4);
    }

    drawOldFisherman(ctx) {
      const { x, y } = this;
      const ox = x - 6;
      const oy = y - 22; // يقف خلف طاولة المتجر

      // جذع الصياد وسترته البحرية الصوفية الداكنة
      ctx.fillStyle = '#1e384d';
      ctx.beginPath();
      ctx.roundRect(ox - 10, oy - 18, 20, 20, 3);
      ctx.fill();

      // رأس الصياد العجوز وملامح الوجه
      ctx.fillStyle = '#d49a75';
      ctx.beginPath();
      ctx.arc(ox, oy - 23, 6.5, 0, Math.PI * 2);
      ctx.fill();

      // عينان وحواجب بيضاء كثيفة
      ctx.fillStyle = '#f0f3f5';
      ctx.fillRect(ox - 5, oy - 27, 4, 1.6);
      ctx.fillRect(ox + 1, oy - 27, 4, 1.6);
      ctx.fillStyle = '#22150c';
      ctx.fillRect(ox - 4, oy - 25, 1.8, 1.5);
      ctx.fillRect(ox + 2, oy - 25, 1.8, 1.5);

      // لحية بيضاء كثيفة تغطي أسفل الوجه والصدر
      ctx.fillStyle = '#e8edf0';
      ctx.beginPath();
      ctx.moveTo(ox - 6, oy - 22);
      ctx.quadraticCurveTo(ox - 7, oy - 12, ox, oy - 10);
      ctx.quadraticCurveTo(ox + 7, oy - 12, ox + 6, oy - 22);
      ctx.closePath();
      ctx.fill();

      // قبعة بحارة صفراء خردلية قديمة
      ctx.fillStyle = '#c98a1a';
      ctx.beginPath();
      ctx.arc(ox, oy - 27, 6.8, Math.PI, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#9c680e';
      ctx.beginPath();
      ctx.roundRect(ox - 7.5, oy - 28, 15, 3.2, 1.2);
      ctx.fill();
    }

    drawCounter(ctx) {
      const { x, y } = this;
      // واجهة طاولة المتجر الخشبية
      ctx.fillStyle = '#422a18';
      ctx.fillRect(x - 38, y - 20, 76, 20);

      // درابزين وحافة سطح الطاولة
      ctx.fillStyle = '#7a5336';
      ctx.fillRect(x - 41, y - 23, 82, 4.5);
      ctx.fillStyle = '#9e724e';
      ctx.fillRect(x - 41, y - 23, 82, 1.2);

      // فانوس بحري دافئ معلق على العمود الأيسر
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(x - 40, y - 50, 4, 7);
      ctx.fillStyle = 'rgba(255, 195, 60, 0.95)';
      ctx.beginPath();
      ctx.arc(x - 38, y - 46, 3, 0, Math.PI * 2);
      ctx.fill();

      // توهج دافئ ناعم وخفيف للفانوس
      const lanternGlow = ctx.createRadialGradient(x - 38, y - 46, 1, x - 38, y - 46, 16);
      lanternGlow.addColorStop(0.0, 'rgba(255, 210, 90, 0.35)');
      lanternGlow.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = lanternGlow;
      ctx.beginPath();
      ctx.arc(x - 38, y - 46, 16, 0, Math.PI * 2);
      ctx.fill();
    }

    drawSign(ctx) {
      const { x, y } = this;
      const signY = y - 58;

      // سلسلتا تعليق معدنيتان
      ctx.strokeStyle = '#222';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - 18, y - 68); ctx.lineTo(x - 18, signY);
      ctx.moveTo(x + 18, y - 68); ctx.lineTo(x + 18, signY);
      ctx.stroke();

      // لوحة خشبية أنيقة
      ctx.fillStyle = '#2e1c10';
      ctx.fillRect(x - 25, signY, 50, 16);
      ctx.fillStyle = '#c79862';
      ctx.fillRect(x - 23, signY + 1.5, 46, 13);
      ctx.strokeStyle = '#5a371c';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(x - 23, signY + 1.5, 46, 13);

      // كتابة كلمة Shop بوضوح ودقة
      ctx.fillStyle = '#2b1608';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Shop', x, signY + 8.5);
    }

    drawLight(lCtx) {
      const lx = this.x - 38;
      const ly = this.y - 46;
      const g = lCtx.createRadialGradient(lx, ly, 2, lx, ly, 90);
      g.addColorStop(0.0, 'rgba(255, 210, 100, 0.95)');
      g.addColorStop(0.35, 'rgba(235, 140, 35, 0.45)');
      g.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
      lCtx.fillStyle = g;
      lCtx.beginPath();
      lCtx.arc(lx, ly, 90, 0, Math.PI * 2);
      lCtx.fill();
    }
  }

  class Fisherman {
    constructor(terrain, dock) {
      this.terrain = terrain;
      this.dock = dock;
      this.x = dock.startX + 35; // يقف فوق الرصيف بالقرب من مدخل المنحدر
      this.y = dock.deckY;
      this.vx = 0;
      this.vy = 0;
      this.facing = -1;
      this.isGrounded = true;
      this.mode = 'walk';
      this.inSubmarine = false;
      this.animTime = 0;
      this.swimAngle = 0;
      this.health = 100;
      this.oxygen = 100;
      this.isDead = false;
      this.crushed = false;
      this.deathTimer = 0;
      this.bloodBurst = [];
      this.droppedLight = null; // كشاف ساقط يهوي في الماء عند الموت
      this.lightOn = true;
      this.bubbleTimer = 0;
      this.bubbles = new ObjectPool(() => ({ x: 0, y: 0, vy: 0, r: 0, a: 0 }), 48);

      // متغيرات وضع المطور
      this.speedMultiplier = 1.0;
      this.jumpMultiplier = 1.0;
      this.godMode = false;

      // محاكاة نظام الكشاف المتقدم المطابق للغواصة
      this.lightData = null;
      this._geomKey = null;
      this._lightConeLayer = null;
      this._lightConeCtx = null;
      this._fogLayer = null;
      this._fogCtx = null;
      this._lastBT = 0;
      this._bounceA = 0;
      this._bounceInit = false;

      // عوالق مائية مضيئة خاصة بكشاف الغواص
      this.motes = [];
      for (let i = 0; i < Quality.q.diverMotes; i++) {
        this.motes.push({
          x: this.x + (Math.random() - 0.5) * 450,
          y: this.y + (Math.random() - 0.5) * 450,
          vx: (Math.random() - 0.5) * 2.5,
          vy: -0.8 - Math.random() * 1.8,
          r: 0.8 + Math.random() * 1.2
        });
      }
    }

    // حساب موضع وزاوية انبعاث الضوء بدقة متطابقة هندسياً 100% مع عدسة الكشاف المرسوم في يد الشخصية
    getLightEmitter() {
      if (this.mode === 'dive') {
        const cosA = Math.cos(this.swimAngle), sinA = Math.sin(this.swimAngle);
        const flipY = (cosA < 0) ? -1 : 1;
        const swimBob = Math.sin(this.animTime * 0.8) * 1.5;
        // موضع العدسة في مساحة الغواص: الكتف (6,2) + الذراع والكشاف المدمج (19.8, 0)
        const lx = 25.8;
        const ly = 2.0 + swimBob;
        return {
          x: this.x + cosA * lx - sinA * (ly * flipY),
          y: this.y + sinA * lx + cosA * (ly * flipY),
          angle: this.swimAngle
        };
      } else {
        const stride = Math.sin(this.animTime);
        const bob = Math.abs(stride) * 2.5;
        const armAngle = (stride * 10 * Math.PI) / 180;
        const cosArm = Math.cos(armAngle), sinArm = Math.sin(armAngle);
        // فوهة الكشاف المدمج بالنسبة لمفصل الكتف: ذراع (0, 11.5) + عدسة (6.8, 0)
        const lx_sh = cosArm * 6.8 - sinArm * 11.5;
        const ly_sh = sinArm * 6.8 + cosArm * 11.5;
        const f = this.facing;
        return {
          x: this.x + f * (2 + lx_sh),
          y: this.y + (-22 + bob + ly_sh),
          angle: (f > 0) ? armAngle : (Math.PI - armAngle)
        };
      }
    }

    // قناع زاوي cos موحد دائري يمنع تشققات الضوء تماماً (مطابق للغواصة)
    _applyConicMask(c, emitX, emitY, safeAngle, coneAngle) {
      if (!c.createConicGradient) return;
      c.globalCompositeOperation = 'destination-in';
      const coneSpan = (coneAngle * 2) / (Math.PI * 2);
      const conicMask = c.createConicGradient(safeAngle - coneAngle, emitX, emitY);
      for (let s = 0; s <= 24; s++) {
        const t = s / 24;
        const aa = Math.cos(Math.abs(t - 0.5) * Math.PI);
        conicMask.addColorStop(t * coneSpan, `rgba(255, 255, 255, ${aa.toFixed(3)})`);
      }
      c.fillStyle = conicMask;
      c.fill();
      c.globalCompositeOperation = 'source-over';
    }

    // إضاءة سطحية ارتدادية متوهجة تعانق كامل الأسطح المضاءة (مطابقة لنظام الغواصة لكن بلون كهرماني دافئ)
    drawSurfaceBounce(ctx, lightOrX, dtOrY, maybeDt) {
      const ld = (typeof lightOrX === 'object' && lightOrX !== null) ? lightOrX : this.lightData;
      const dt = ((typeof lightOrX === 'object') ? dtOrY : maybeDt) || 0.016;
      if (!ld || !ld.hitPoints || ld.hitPoints.length === 0) return;

      const { hitPoints, worldEmitX, worldEmitY, range } = ld;
      const hits = [];
      for (let i = 0; i < hitPoints.length; i++) {
        const p = hitPoints[i];
        if (p.hit) hits.push(p);
      }

      const hasHits = hits.length >= 2;
      if (!this._bounceInit) { this._bounceA = 0; this._bounceInit = true; }
      this._bounceA = hasHits ? Math.min(1, this._bounceA + 8 * dt) : Math.max(0, this._bounceA - 8 * dt);
      if (this._bounceA <= 0.02 || !hasHits) return;

      const mid = hits[Math.floor(hits.length / 2)];
      const dist = Math.hypot(mid.x - worldEmitX, mid.y - worldEmitY);
      const dNorm = Math.max(0, Math.min(1, dist / range));

      // تقوية معامل السطوع السطحي لإضاءة الرصيف والرمال بوضوح تام
      const alpha = Math.pow(1 - dNorm, 1.6) * 0.48 * this._bounceA;
      if (alpha < 0.01) return;

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // 1. تشتت ضوئي أزرق ناصع وواضح على الأرضيات
      ctx.beginPath();
      ctx.moveTo(hits[0].x, hits[0].y);
      for (let i = 1; i < hits.length; i++) ctx.lineTo(hits[i].x, hits[i].y);
      ctx.strokeStyle = `rgba(75, 170, 245, ${(alpha * 0.45).toFixed(3)})`;
      ctx.lineWidth = Math.max(12, Math.min(26, (1 - dNorm) * 12 + 14));
      ctx.stroke();

      // 2. توهج ملامسة ناصع ومشرق يسقط على الرصيف والرمال
      ctx.beginPath();
      ctx.moveTo(hits[0].x, hits[0].y);
      for (let i = 1; i < hits.length; i++) ctx.lineTo(hits[i].x, hits[i].y);
      ctx.strokeStyle = `rgba(225, 248, 255, ${(alpha * 0.95).toFixed(3)})`;
      ctx.lineWidth = Math.max(4.5, Math.min(9.0, (1 - dNorm) * 4 + 5));
      ctx.stroke();

      ctx.restore();
    }

    // إضاءة كشاف الغواص الديناميكية على الـ Light Map مع طبقة كاش مؤقتة وتصادمات دقيقة شاملة
    drawSearchlightIllumination(lCtx, terrain, submarine) {
      if (!this.lightOn || this.inSubmarine) {
        this.lightData = null;
        this._geomKey = null;
        return;
      }

      const emit = this.getLightEmitter();
      let worldEmitX = emit.x;
      let worldEmitY = emit.y;
      const safeAngle = Number.isFinite(emit.angle) ? emit.angle : 0;
      const range = 330;
      const coneAngle = 0.35;

      // 1. حماية نقطة انبعاث الكشاف من التداخل داخل الجدران أو التضاريس أو الرصيف أو الغواصة
      if (worldEmitY >= 1000) {
        const wX = terrain.getWallX(worldEmitY);
        if (worldEmitX >= wX - 5) worldEmitX = wX - 5;
      } else {
        const gY = terrain.getHeightAt(worldEmitX);
        if (worldEmitY >= gY - 4) worldEmitY = gY - 4;
        const rY = terrain.getRockSurfaceAt(worldEmitX);
        if (rY !== null && worldEmitY >= rY - 4) worldEmitY = rY - 4;
        if (this.dock) {
          const dY = this.dock.getSurfaceY(worldEmitX);
          if (dY !== null && worldEmitY >= dY - 2 && worldEmitY <= dY + 16) {
            worldEmitY = dY - 3;
          }
        }
      }
      const conePad = range + 25;
      const geomKey = Math.round(worldEmitX) + '|' + Math.round(worldEmitY) + '|' + Math.round(safeAngle * 512) + '|' + Quality.q.diverRays;

      if (geomKey !== this._geomKey) {
        this._geomKey = geomKey;
        const rays = Quality.q.diverRays;
        const step = 5;
        const hitPoints = [];
        let centerHitX = 0, centerHitY = 0;
        let isCenterHit = false;

        // دالة فحص الاصطدام الشاملة للأشعة
        const checkHit = (rx, ry) => {
          // أ. الجدار الصخري السحيق وقاع الخندق
          if (ry >= 1000) {
            if (rx >= terrain.getWallX(ry)) return true;
            if (ry >= 60000) {
              const floorX = Math.min(WORLD.WALL_X - 120, rx);
              if (ry >= terrain.getHeightAt(floorX)) return true;
            }
          } else {
            // ب. التضاريس والمنحدرات والصخور الضحلة
            const gy = terrain.getHeightAt(rx);
            const rySurf = terrain.getRockSurfaceAt(rx);
            const surfY = rySurf !== null ? Math.min(gy, rySurf) : gy;
            if (ry >= surfY) return true;
          }

          // ج. الرصيف الخشبي (ألواح السطح والأعمدة الداعمة)
          if (this.dock) {
            const dY = this.dock.getSurfaceY(rx);
            if (dY !== null && ry >= dY - 1 && ry <= dY + 14) return true;
            if (this.dock.stilts) {
              for (let s = 0; s < this.dock.stilts.length; s++) {
                const sx = this.dock.stilts[s];
                if (Math.abs(rx - sx) <= 5.5) {
                  const by = terrain.getHeightAt(sx);
                  if (ry >= this.dock.deckY && ry <= by) return true;
                }
              }
            }
          }

          return false;
        };

        for (let i = 0; i <= rays; i++) {
          const currentAngle = safeAngle - coneAngle + (i / rays) * (coneAngle * 2);
          let rayX = worldEmitX, rayY = worldEmitY, dist = 0;
          const cosR = Math.cos(currentAngle), sinR = Math.sin(currentAngle);
          let hit = false;

          while (dist < range) {
            rayX += cosR * step;
            rayY += sinR * step;
            dist += step;

            if (checkHit(rayX, rayY)) {
              // بحث ثنائي عالي الدقة (Binary Search Refinement) لتحديد نقطة الارتطام بدقة متناهية
              let low = dist - step, high = dist;
              for (let b = 0; b < 4; b++) {
                const mid = (low + high) * 0.5;
                const mx = worldEmitX + cosR * mid;
                const my = worldEmitY + sinR * mid;
                if (checkHit(mx, my)) high = mid; else low = mid;
              }
              const safeDist = Math.max(3, high);
              rayX = worldEmitX + cosR * safeDist;
              rayY = worldEmitY + sinR * safeDist;
              hit = true;
              break;
            }
          }

          hitPoints.push({ x: rayX, y: rayY, hit });
          if (i === Math.floor(rays / 2) && hit) {
            centerHitX = rayX; centerHitY = rayY; isCenterHit = true;
          }
        }

        this.lightData = { worldEmitX, worldEmitY, hitPoints, isCenterHit, centerHitX, centerHitY, range, rays, safeAngle, coneAngle };

        if (!this._lightConeLayer) {
          this._lightConeLayer = document.createElement('canvas');
          this._lightConeCtx = this._lightConeLayer.getContext('2d');
        }
        if (this._lightConeLayer.width !== conePad * 2 || this._lightConeLayer.height !== conePad * 2) {
          this._lightConeLayer.width = conePad * 2;
          this._lightConeLayer.height = conePad * 2;
        }

        const cc = this._lightConeCtx;
        cc.setTransform(1, 0, 0, 1, 0, 0);
        cc.globalCompositeOperation = 'source-over';
        cc.clearRect(0, 0, conePad * 2, conePad * 2);
        cc.translate(conePad - worldEmitX, conePad - worldEmitY);

        cc.save();
        cc.beginPath();
        cc.moveTo(worldEmitX, worldEmitY);
        for (const hp of hitPoints) cc.lineTo(hp.x, hp.y);
        cc.closePath();

        // تدرج ضوئي ناصع وعالي التباين يخترق ظلمة السطح والماء
        const coneGrad = cc.createRadialGradient(worldEmitX, worldEmitY, 2, worldEmitX, worldEmitY, range);
        coneGrad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
        coneGrad.addColorStop(0.18, 'rgba(240, 250, 255, 0.98)');
        coneGrad.addColorStop(0.52, 'rgba(160, 220, 255, 0.78)');
        coneGrad.addColorStop(0.82, 'rgba(70, 165, 245, 0.40)');
        coneGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
        cc.fillStyle = coneGrad;
        cc.fill();
        cc.restore();

        this._applyConicMask(cc, worldEmitX, worldEmitY, safeAngle, coneAngle);
      }

      // بؤرة عدسة مضيئة وحية بقوة
      lCtx.save();
      const emitGrad = lCtx.createRadialGradient(worldEmitX, worldEmitY, 1, worldEmitX, worldEmitY, 16);
      emitGrad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
      emitGrad.addColorStop(0.40, 'rgba(195, 235, 255, 0.65)');
      emitGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
      lCtx.fillStyle = emitGrad;
      lCtx.beginPath();
      lCtx.arc(worldEmitX, worldEmitY, 16, 0, Math.PI * 2);
      lCtx.fill();
      lCtx.restore();

      if (this._lightConeLayer) {
        lCtx.drawImage(this._lightConeLayer, worldEmitX - conePad, worldEmitY - conePad);
      }

      // حساب انعكاس الضوء السطحي المرتد على الأجسام
      const nowT = performance.now();
      const dtB = this._lastBT ? Math.min(0.05, (nowT - this._lastBT) / 1000) : 0.016;
      this._lastBT = nowT;
      lCtx.save();
      lCtx.globalCompositeOperation = 'screen';
      this.drawSurfaceBounce(lCtx, this.lightData, dtB);
      lCtx.restore();
    }

    // تشتت الضوء الحجمي الساطع في الهواء واليابسة وتحت الماء
    drawAdditiveEffects(ctx) {
      if (!this.lightOn || this.inSubmarine) return;
      if (!this.lightData) return;

      const { worldEmitX, worldEmitY, hitPoints, range, safeAngle, coneAngle } = this.lightData;

      if (!this._fogLayer) {
        this._fogLayer = document.createElement('canvas');
        this._fogCtx = this._fogLayer.getContext('2d');
      }
      const fogPad = range + 25;
      if (this._fogLayer.width !== fogPad * 2 || this._fogLayer.height !== fogPad * 2) {
        this._fogLayer.width = fogPad * 2;
        this._fogLayer.height = fogPad * 2;
      }

      const fc = this._fogCtx;
      fc.setTransform(1, 0, 0, 1, 0, 0);
      fc.globalCompositeOperation = 'source-over';
      fc.clearRect(0, 0, fogPad * 2, fogPad * 2);
      fc.translate(fogPad - worldEmitX, fogPad - worldEmitY);

      fc.save();
      fc.beginPath();
      fc.moveTo(worldEmitX, worldEmitY);
      for (const hp of hitPoints) fc.lineTo(hp.x, hp.y);
      fc.closePath();

      // شعاع ضوئي حيوي ناصع يظهر في الهواء والماء بنفس القوة
      const fogGrad = fc.createRadialGradient(worldEmitX, worldEmitY, 4, worldEmitX, worldEmitY, range);
      fogGrad.addColorStop(0.0, 'rgba(215, 245, 255, 0.28)');
      fogGrad.addColorStop(0.28, 'rgba(125, 205, 255, 0.16)');
      fogGrad.addColorStop(0.68, 'rgba(45, 140, 235, 0.06)');
      fogGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
      fc.fillStyle = fogGrad;
      fc.fill();
      fc.restore();

      this._applyConicMask(fc, worldEmitX, worldEmitY, safeAngle, coneAngle);

      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.drawImage(this._fogLayer, worldEmitX - fogPad, worldEmitY - fogPad);

      // ذرات الضوء تظهر فقط عندما يكون الكشاف مغموراً في الماء
      if (this.y > WORLD.WATER_Y + 5) {
        const depthM = Math.max(0, (this.y - WORLD.WATER_Y) / WORLD.PIXELS_PER_METER);
        const depthIntensity = Math.min(1.0, 0.2 + Math.pow(Math.min(1.0, depthM / 50), 1.4) * 0.8);
        for (const m of this.motes) {
          const dx = m.x - worldEmitX, dy = m.y - worldEmitY;
          const dist = Math.hypot(dx, dy);
          if (dist > 8 && dist < range) {
            const ang = Math.atan2(dy, dx);
            const diff = Math.abs(Math.atan2(Math.sin(ang - safeAngle), Math.cos(ang - safeAngle)));
            if (diff < coneAngle) {
              const alpha = (1 - dist / range) * (1 - diff / coneAngle) * 0.90 * depthIntensity;
              ctx.fillStyle = `rgba(220, 245, 255, ${alpha.toFixed(3)})`;
              ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2); ctx.fill();
            }
          }
        }
      }

      ctx.restore();
    }
    update(dt, joystick, submarine, jumpRequested) {
      // دعم وضع الخلود للمطور
      if (this.godMode) {
        this.health = 100;
        this.oxygen = 100;
        this.isDead = false;
      }

      // علاج صحة اللاعب وتعبئة الأكسجين بسرعة داخل الغواصة
      if (this.inSubmarine) {
        if (this.health < 100) this.health = Math.min(100, this.health + 8 * dt);
        if (this.oxygen < 100) this.oxygen = Math.min(100, this.oxygen + 35 * dt);
        return;
      }

      // محاكاة موت اللاعب وسقوط الكشاف من يده في الماء
      if (this.isDead) {
        this.deathTimer += dt;
        // اللاعب لا يختفي فجأة؛ يبقى جسده طافياً ببطء مع انعدام التحكم
        this.vx *= Math.exp(-2.2 * dt);
        this.vy = Math.min(18, this.vy + 12 * dt);
        this.x += this.vx * dt;
        this.y += this.vy * dt;

        // الكشاف يسقط من يده ويهوي في قاع البحر مع دورانه وإشعاعه
        if (this.droppedLight) {
          const dl = this.droppedLight;
          dl.y += dl.vy * dt;
          dl.x += dl.vx * dt;
          dl.angle += dl.vRot * dt;
          dl.vy = Math.min(45, dl.vy + 18 * dt);
        }

        for (const b of this.bloodBurst) {
          b.x += b.vx * dt; b.y += b.vy * dt; b.r += 1.8 * dt; b.a -= 0.18 * dt;
        }
        return;
      }

      // فحص أسطح الرصيف الأفقي والمنحدر الخشبي المائل
      const dockSurfaceY = this.dock.getSurfaceY(this.x);
      const rockSurfaceY = this.terrain.getRockSurfaceAt ? this.terrain.getRockSurfaceAt(this.x) : null;
      const baseGroundY = this.terrain.getHeightAt(this.x);
      
      let activeFloorY = baseGroundY;
      let onSolidSurface = false;

      if (dockSurfaceY !== null) {
        // التأكد من ملامسة سطح الرصيف أو المنحدر المائل
        if (this.y <= dockSurfaceY + 20 || (this.mode === 'walk' && this.y <= dockSurfaceY + 28)) {
          activeFloorY = dockSurfaceY;
          onSolidSurface = true;
        }
      } else if (rockSurfaceY !== null) {
        // الصخور تعتبر سطحاً قابلاً للمشي فقط إذا كانت قريبة من سطح الماء (ضحلة)
        // هذا يمنع تحول اللاعب للمشي عند ملامسة الصخور العميقة أو السقوط بجانبها
        const isShallowRock = rockSurfaceY <= WORLD.WATER_Y + 45;
        
        if (isShallowRock && this.y <= rockSurfaceY + 24) {
          activeFloorY = rockSurfaceY;
          onSolidSurface = true;
        }
      }

      const onLand = (this.x >= WORLD.SHORE_X || onSolidSurface);
      const inWater = (!onLand && this.y > WORLD.WATER_Y + 6);
      const depthM = inWater ? (this.y - WORLD.WATER_Y) / WORLD.PIXELS_PER_METER : 0;

      // سحق فوري وموت وسقوط الكشاف عند عمق 500م أو نفاد الأكسجين (مع استثناء وضع الخلود)
      if (inWater && depthM >= 500 && !this.godMode) {
        this.isDead = true;
        this.health = 0;
        this.lightOn = false;
        // إفلات الكشاف في الماء
        this.droppedLight = { x: this.x, y: this.y, vx: this.vx * 0.4, vy: 14, angle: this.swimAngle, vRot: 1.8 };
        for (let i = 0; i < 24; i++) {
          this.bloodBurst.push({
            x: this.x, y: this.y,
            vx: (Math.random() - 0.5) * 25, vy: (Math.random() - 0.5) * 20,
            r: 5 + Math.random() * 9, a: 0.95
          });
        }
        return;
      }

      // استهلاك الأكسجين عند الغوص (يكفي ~35 ثانية) والتعبئة عند السطح
      if (inWater) {
        if (!this.godMode) {
          this.oxygen = Math.max(0, this.oxygen - 2.8 * dt);
          if (this.oxygen <= 0 || depthM > 100) {
            this.health = Math.max(0, this.health - (depthM > 100 ? 18 : 10) * dt);
            if (this.health <= 0) {
              this.isDead = true;
              for (let i = 0; i < 10; i++) {
                this.bloodBurst.push({ x: this.x, y: this.y, vx: (Math.random() - 0.5) * 15, vy: -8, r: 3, a: 0.8 });
              }
              return;
            }
          }
        }
      } else {
        if (this.oxygen < 100) this.oxygen = Math.min(100, this.oxygen + 18 * dt);
      }

      if (inWater) {
        // انتقال سلس من المشي إلى السباحة الحرة
        if (this.mode !== 'dive') {
          this.mode = 'dive';
          this.isGrounded = false;
          this.swimAngle = Math.atan2(this.vy, this.vx || (this.facing * 10));
        }

        // الصعود المباشر إلى المنحدر المائل عند لمسه والسباحة نحوه
        if (dockSurfaceY !== null && this.y >= dockSurfaceY - 14) {
          if (joystick.dirX > 0.1 || joystick.dirY < -0.15 || jumpRequested) {
            this.mode = 'walk';
            this.y = dockSurfaceY;
            this.vy = 0;
            this.isGrounded = true;
            this.swimAngle = 0;
            return;
          }
        }

        const swimSpeed = 95 * (this.speedMultiplier || 1.0);
        if (joystick.force > 0.08) {
          const targetAngle = Math.atan2(joystick.dirY, joystick.dirX);
          const diff = Math.atan2(Math.sin(targetAngle - this.swimAngle), Math.cos(targetAngle - this.swimAngle));
          this.swimAngle += diff * (1 - Math.exp(-8 * dt));
          this.facing = Math.cos(this.swimAngle) >= 0 ? 1 : -1;

          this.vx += Math.cos(this.swimAngle) * swimSpeed * joystick.force * dt * 7;
          this.vy += Math.sin(this.swimAngle) * swimSpeed * joystick.force * dt * 7;
          this.animTime += dt * 6.5;
        } else {
          this.animTime += dt * 1.2;
        }

        // تطبيق مقاومة الماء بشكل مستمر وسلس
        const waterDrag = Math.exp(-3.5 * dt);
        this.vx *= waterDrag;
        this.vy *= waterDrag;
        this.x += this.vx * dt;
        this.y += this.vy * dt;

        // تصادم الجدار الصخري السحيق (ينفذ أولاً لمنع تداخل الإحداثيات السينية)
        if (this.y >= 1000) {
          const t = Math.max(0, Math.min(1, (this.y - 1000) / 65400));
          const crag = Math.sin(this.y * 0.003) * 44 + Math.cos(this.y * 0.008) * 28 + Math.sin(this.y * 0.02) * 14;
          const wallX = WORLD.WALL_X + crag - t * 45;
          if (this.x > wallX - 12) {
            this.x = wallX - 12;
            this.vx = Math.min(0, this.vx);
          }
        }

        // منع الصعود فوق الماء ومنع اختراق القاع السحيق مع التكيف في المياه الضحلة
        let safeFloorY = baseGroundY;
        if (this.y > 1000 && baseGroundY <= 1000) {
          safeFloorY = 66500;
        }
        const topLimit = WORLD.WATER_Y + 8;
        const botLimit = safeFloorY - 12;
        if (botLimit > topLimit) {
          this.y = Math.max(topLimit, Math.min(botLimit, this.y));
        } else {
          this.y = botLimit;
        }

        // تصادم الغواص مع الحاجز الصخري أثناء السباحة (منطق تصادم طبيعي يمنع الرفع التلقائي)
        const barrier = this.terrain.rockBarrier;
        if (barrier) {
          const rSurf = this.terrain.getRockSurfaceAt(this.x);
          if (rSurf !== null && this.y > rSurf - 14) {
            // حساب الموقع السابق لمعرفة من أين جاء اللاعب
            const prevX = this.x - this.vx * dt;
            const rSurfPrevX = this.terrain.getRockSurfaceAt(prevX);
            
            let isWall = false;
            if (rSurfPrevX === null) {
              isWall = true; // اصطدام بالحافة الخارجية للصخور (جدار صلب)
            } else if (Math.abs(this.x - prevX) > 0.1) {
              // حساب ميل الصخرة: إذا كان الانحدار شديداً نعتبره جداراً وليس أرضية
              const slope = (rSurfPrevX - rSurf) / Math.abs(this.x - prevX);
              if (slope > 1.5) { 
                isWall = true;
              }
            }

            if (isWall) {
              // اللاعب اصطدم بجدار أفقياً: نوقفه في مكانه دون رفعه للأعلى
              this.x = prevX;
              this.vx = 0; 
            } else {
              // اللاعب هبط على أرضية أو يسبح فوق منحدر خفيف: نوقفه عمودياً
              this.y = rSurf - 14;
              this.vy = Math.min(0, this.vy); 
            }
          }
        }

        this.bubbleTimer += dt;
        if (this.bubbleTimer > 0.42) {
          this.bubbleTimer = 0;
          const bb = this.bubbles.obtain();
          if (bb) { bb.x = this.x - Math.cos(this.swimAngle) * 8; bb.y = this.y - Math.sin(this.swimAngle) * 8; bb.vy = -24; bb.r = 1.8; bb.a = 0.85; }
        }
      } else {
        // الخروج من الماء إلى اليابسة أو الصخور
        if (this.mode === 'dive') {
          this.mode = 'walk';
          this.swimAngle = 0;
        }

        const walkSpeed = 130 * (this.speedMultiplier || 1.0);
        const targetVx = (joystick.force > 0.12) ? joystick.dirX * joystick.force * walkSpeed : 0;
        this.vx += (targetVx - this.vx) * (1 - Math.exp(-14 * dt));

        if (Math.abs(this.vx) > 4) {
          this.facing = this.vx > 0 ? 1 : -1;
          this.animTime += dt * 11;
        } else {
          this.animTime = 0;
        }

        // القفز أثناء المشي أو فوق المنحدر الخشبي مع دعم مضاعف القفز
        if (this.isGrounded && jumpRequested) {
          this.vy = -275 * (this.jumpMultiplier || 1.0);
          this.isGrounded = false;
        }

        this.vy += 580 * dt;
        this.x += this.vx * dt;
        this.y += this.vy * dt;

        if (this.y >= activeFloorY) {
          this.y = activeFloorY;
          this.vy = 0;
          this.isGrounded = true;
        } else {
          this.isGrounded = false;
        }
      }

      this.x = Math.max(-50, Math.min(WORLD.WIDTH + 50, this.x));

      this.bubbles.forEachActive((b) => {
        b.y += b.vy * dt;
        b.a -= 0.4 * dt;
        if (b.a <= 0 || b.y < WORLD.WATER_Y) this.bubbles.release(b);
      });

      // تحديث حركة ذرات العوالق المضيئة الخاصة باللاعب
      for (let i = 0; i < this.motes.length; i++) {
        const m = this.motes[i];
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        if (Math.hypot(m.x - this.x, m.y - this.y) > 350) {
          m.x = this.x + (Math.random() - 0.5) * 450;
          m.y = this.y + (Math.random() - 0.5) * 450;
        }
      }
    }

    draw(ctx, submarine) {
      if (this.inSubmarine) return;

      // رسم سحاب الدم والكشاف الساقط في الماء
      if (this.bloodBurst.length > 0) {
        ctx.save();
        for (const b of this.bloodBurst) {
          if (b.a <= 0) continue;
          ctx.fillStyle = `rgba(145, 12, 12, ${b.a.toFixed(3)})`;
          ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
        }
        ctx.restore();
      }

      // رسم الكشاف أثناء هبوطه وسقوطه في الماء
      if (this.droppedLight) {
        const dl = this.droppedLight;
        ctx.save();
        ctx.translate(dl.x, dl.y);
        ctx.rotate(dl.angle);
        ctx.fillStyle = '#1e272e';
        ctx.fillRect(-2, -2, 7, 4);
        ctx.fillStyle = '#00e5ff';
        ctx.beginPath(); ctx.arc(5, 0, 2.5, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }

      // فقاعات تنفس الغواص
      ctx.save();
      ctx.fillStyle = 'rgba(215, 245, 255, 0.75)';
      this.bubbles.forEachActive((b) => {
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.restore();

      // الإضاءة والتفاعل مع الكشاف أصبح يتم تلقائياً عبر نظام الـ Light Map السينمائي
      let amb = 1.0;

      ctx.save();
      ctx.translate(this.x, this.y);

      if (this.mode === 'dive') {
        // دوران 360° حر وتعتيم تدريجي لألوان الغواص بحسب عمق الظلام أو كشاف الغواصة
        ctx.rotate(this.swimAngle);
        if (Math.cos(this.swimAngle) < 0) ctx.scale(1, -1);

        // إضافة حركة انسيابية (Bobbing) أثناء السباحة
        const swimBob = Math.sin(this.animTime * 0.8) * 1.5;
        ctx.translate(0, swimBob);

        const kick = Math.sin(this.animTime);
        const armCycle = Math.cos(this.animTime);

        // 1. أسطوانة الأكسجين التكتيكية المدمجة والمثبتة بحزام BCD على الظهر
        ctx.fillStyle = `rgb(${Math.round(160*amb)}, ${Math.round(175*amb)}, ${Math.round(180*amb)})`;
        ctx.beginPath();
        ctx.roundRect(-11, -12, 19, 5.8, 2.4);
        ctx.fill();
        // صمام الأسطوانة المتصل بخرطوم التنفس
        ctx.fillStyle = `rgb(${Math.round(210*amb)}, ${Math.round(55*amb)}, ${Math.round(45*amb)})`;
        ctx.fillRect(-13, -11.2, 2.5, 4.2);
        // أحزمة تثبيت الأسطوانة ببدلة الغواص
        ctx.fillStyle = '#0f171e';
        ctx.fillRect(-7, -12.5, 2.2, 6.8);
        ctx.fillRect(2, -12.5, 2.2, 6.8);

        // 2. الساقان المفصليتان وزعانف الغوص الانسيابية (Jet-Fins) بحركة تموجية
        ctx.save();
        ctx.translate(-12, -2);
        const legPhase = Math.cos(this.animTime);

        // الساق العلوية والزعنفة
        ctx.save();
        ctx.rotate((kick * 24 * Math.PI) / 180);
        ctx.fillStyle = `rgb(${Math.round(25*amb)}, ${Math.round(70*amb)}, ${Math.round(105*amb)})`;
        ctx.fillRect(-13, -2.2, 13, 4.4);
        // مفصل الركبة والزعنفة ذات الفتحات الهيدروديناميكية
        ctx.translate(-13, 0);
        ctx.rotate((legPhase * 10 * Math.PI) / 180);
        ctx.fillStyle = '#0f171e';
        ctx.fillRect(-3, -2.0, 3.5, 4.0);
        ctx.fillStyle = `rgb(${Math.round(241*amb)}, ${Math.round(160*amb)}, ${Math.round(20*amb)})`;
        ctx.beginPath();
        ctx.moveTo(-2, -2.0);
        ctx.lineTo(-14, -4.5);
        ctx.quadraticCurveTo(-15, 0, -14, 4.5);
        ctx.lineTo(-2, 2.0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // الساق السفلية والزعنفة المعاكسة
        ctx.save();
        ctx.rotate((-kick * 24 * Math.PI) / 180);
        ctx.fillStyle = `rgb(${Math.round(30*amb)}, ${Math.round(85*amb)}, ${Math.round(125*amb)})`;
        ctx.fillRect(-13, -0.5, 13, 4.4);
        ctx.translate(-13, 1.5);
        ctx.rotate((-legPhase * 10 * Math.PI) / 180);
        ctx.fillStyle = '#0f171e';
        ctx.fillRect(-3, -2.0, 3.5, 4.0);
        ctx.fillStyle = `rgb(${Math.round(241*amb)}, ${Math.round(160*amb)}, ${Math.round(20*amb)})`;
        ctx.beginPath();
        ctx.moveTo(-2, -2.0);
        ctx.lineTo(-14, -4.5);
        ctx.quadraticCurveTo(-15, 0, -14, 4.5);
        ctx.lineTo(-2, 2.0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.restore();

        // 3. بدلة الغوص والسترة التكتيكية
        ctx.fillStyle = `rgb(${Math.round(21*amb)}, ${Math.round(67*amb)}, ${Math.round(96*amb)})`;
        ctx.beginPath();
        ctx.roundRect(-12, -8, 24, 11, 4);
        ctx.fill();

        // 4. رأس الغواص وقناع الغوص الأنيق
        ctx.fillStyle = `rgb(${Math.round(245*amb)}, ${Math.round(203*amb)}, ${Math.round(167*amb)})`;
        ctx.beginPath();
        ctx.arc(14, -4, 6.5, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `rgba(80, 220, 255, ${0.75 * amb})`;
        ctx.strokeStyle = `rgb(${Math.round(27*amb)}, ${Math.round(38*amb)}, ${Math.round(49*amb)})`;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.roundRect(14, -8, 7, 6, 2);
        ctx.fill();
        ctx.stroke();

        ctx.strokeStyle = '#1e272e';
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.moveTo(14, -5); ctx.lineTo(8, -5);
        ctx.stroke();

        // 5. الذراع الخلفية بنمط تجديف مائي انسيابي
        ctx.save();
        ctx.translate(4, -3);
        ctx.rotate((-armCycle * 25 * Math.PI) / 180);
        ctx.fillStyle = `rgb(${Math.round(18*amb)}, ${Math.round(55*amb)}, ${Math.round(80*amb)})`;
        ctx.beginPath();
        ctx.roundRect(-2, 0, 4, 11, 2);
        ctx.fill();
        ctx.restore();

        // 6. الذراع الأمامية الممدودة للأمام بكشاف الغوص الاستكشافي في اليد
        ctx.save();
        ctx.translate(6, 2);
        ctx.fillStyle = `rgb(${Math.round(230*amb)}, ${Math.round(126*amb)}, ${Math.round(34*amb)})`;
        ctx.beginPath();
        ctx.roundRect(0, -2.5, 14, 5, 2.5);
        ctx.fill();

        ctx.fillStyle = `rgb(${Math.round(245*amb)}, ${Math.round(203*amb)}, ${Math.round(167*amb)})`;
        ctx.beginPath();
        ctx.arc(14, 0, 2.5, 0, Math.PI * 2);
        ctx.fill();

        // كشاف الغوص التكتيكي المحمول باليد (مطابق لهندسة ومعدن مصباح الغواصة)
        ctx.save();
        ctx.translate(13, 0);

        ctx.fillStyle = '#2f3542';
        ctx.fillRect(-1, -1.6, 2.2, 3.2);

        ctx.fillStyle = '#1e272e';
        ctx.beginPath();
        ctx.roundRect(1, -1.8, 5, 3.6, 1);
        ctx.fill();
        ctx.strokeStyle = '#57606f';
        ctx.lineWidth = 0.8;
        ctx.stroke();

        ctx.fillStyle = '#8395a7';
        ctx.fillRect(6, -1.8, 0.8, 3.6);

        if (this.lightOn) {
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(6.8, 0, 1.5, -Math.PI * 0.5, Math.PI * 0.5);
          ctx.closePath();
          ctx.fill();

          ctx.strokeStyle = '#cceeff';
          ctx.lineWidth = 0.6;
          ctx.stroke();

          ctx.fillStyle = 'rgba(180, 230, 255, 0.55)';
          ctx.beginPath();
          ctx.arc(6.8, 0, 3.2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = '#263238';
          ctx.beginPath();
          ctx.arc(6.8, 0, 1.4, -Math.PI * 0.5, Math.PI * 0.5);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = '#4b5563';
          ctx.lineWidth = 0.6;
          ctx.stroke();
        }

        ctx.restore();
        ctx.restore();

      } else {
        // قلب صورة اللاعب بالكامل لليسار واليمين على اليابسة بدقة
        ctx.scale(this.facing, 1);
        const stride = Math.sin(this.animTime);
        const bob = Math.abs(stride) * 2.5;

        // 1. الذراع الخلفية تتأرجح عكس حركة الساق الأمامية
        ctx.save();
        ctx.translate(-2, -25 + bob);
        ctx.rotate((-stride * 26 * Math.PI) / 180);
        ctx.fillStyle = '#c0392b';
        ctx.beginPath();
        ctx.roundRect(-2.5, 0, 5, 12, 2.5);
        ctx.fill();
        ctx.fillStyle = '#f5cba7';
        ctx.beginPath();
        ctx.arc(0, 12, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        // 2. الساق الخلفية مع حذاء بحري مانع للانزلاق
        ctx.save();
        ctx.translate(-2.5, -11.5);
        ctx.rotate((-stride * 22 * Math.PI) / 180);
        ctx.fillStyle = '#1c2833';
        ctx.roundRect(-2, 0, 4.2, 11, 1.5);
        ctx.fill();
        ctx.fillStyle = '#0b1016';
        ctx.beginPath();
        ctx.roundRect(-2, 8.5, 7.5, 3.5, 1.2);
        ctx.fill();
        ctx.restore();

        // 3. الجذع وسترة الاستكشاف البحرية مع الحزام التكتيكي
        ctx.fillStyle = '#c0392b';
        ctx.beginPath();
        ctx.roundRect(-6.5, -28 + bob, 13, 16, 3.5);
        ctx.fill();

        ctx.fillStyle = '#d35400';
        ctx.fillRect(-4.5, -26 + bob, 9, 12);
        ctx.strokeStyle = '#962d00';
        ctx.lineWidth = 1.0;
        ctx.strokeRect(-4.5, -26 + bob, 9, 12);

        // حزام الخصر التكتيكي ومشبك الأمان
        ctx.fillStyle = '#1c2833';
        ctx.fillRect(-6.5, -14.5 + bob, 13, 3);
        ctx.fillStyle = '#f1c40f';
        ctx.fillRect(-1.5, -15 + bob, 3, 4);

        // 4. الساق الأمامية
        ctx.save();
        ctx.translate(2, -12);
        ctx.rotate((stride * 24 * Math.PI) / 180);
        ctx.fillStyle = '#2c3e50';
        ctx.fillRect(-2.5, 0, 5, 12);
        ctx.fillStyle = '#0f171e';
        ctx.fillRect(-2.5, 9, 8, 4);
        ctx.restore();

        // 5. الرأس بتفاصيل واقعية وقبعة بحارة تكتيكية (Beanie)
        ctx.save();
        ctx.translate(0, -30 + bob);
        ctx.fillStyle = '#f5cba7';
        ctx.beginPath();
        ctx.arc(0, -5.5, 5.8, 0, Math.PI * 2);
        ctx.fill();

        // ملامح الوجه والأنف الموجه
        ctx.fillStyle = '#e0a980';
        ctx.beginPath();
        ctx.moveTo(3.5, -6.5); ctx.lineTo(7.2, -5.2); ctx.lineTo(3.5, -3.8);
        ctx.fill();
        ctx.fillStyle = '#1c2833';
        ctx.beginPath(); ctx.arc(2.8, -6.2, 1.1, 0, Math.PI * 2); ctx.fill();

        // قبعة بحارة شتوية مضلعة ذات ثنية أنيقة
        ctx.fillStyle = '#962d00';
        ctx.beginPath();
        ctx.arc(-0.5, -6.8, 6.2, Math.PI * 1.05, Math.PI * 1.95);
        ctx.fill();
        ctx.fillStyle = '#c0392b';
        ctx.beginPath();
        ctx.roundRect(-5.2, -9.2, 10.8, 3.8, 1.5);
        ctx.fill();
        ctx.restore();

        // 6. الذراع الأمامية وكشاف الغوص المحمول في اليد على مستوى منتصف الجسم
        const armAngle = (stride * 10 * Math.PI) / 180;
        ctx.save();
        ctx.translate(2, -22 + bob);
        ctx.rotate(armAngle);

        ctx.fillStyle = '#e67e22';
        ctx.beginPath();
        ctx.roundRect(-2.5, 0, 5, 12, 2.5);
        ctx.fill();

        ctx.fillStyle = '#f5cba7';
        ctx.beginPath();
        ctx.arc(0, 11.5, 2.5, 0, Math.PI * 2);
        ctx.fill();

        // كشاف غوص يدوي مدمج بحجم واقعي متناسق مع اليد
        ctx.save();
        ctx.translate(0, 11.5);

        ctx.fillStyle = '#2f3542';
        ctx.fillRect(-1, -1.6, 2.2, 3.2);

        ctx.fillStyle = '#1e272e';
        ctx.beginPath();
        ctx.roundRect(1, -1.8, 5, 3.6, 1);
        ctx.fill();
        ctx.strokeStyle = '#57606f';
        ctx.lineWidth = 0.8;
        ctx.stroke();

        ctx.fillStyle = '#8395a7';
        ctx.fillRect(6, -1.8, 0.8, 3.6);

        if (this.lightOn) {
          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(6.8, 0, 1.5, -Math.PI * 0.5, Math.PI * 0.5);
          ctx.closePath();
          ctx.fill();

          ctx.strokeStyle = '#cceeff';
          ctx.lineWidth = 0.6;
          ctx.stroke();

          ctx.fillStyle = 'rgba(180, 230, 255, 0.55)';
          ctx.beginPath();
          ctx.arc(6.8, 0, 3.2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.fillStyle = '#263238';
          ctx.beginPath();
          ctx.arc(6.8, 0, 1.4, -Math.PI * 0.5, Math.PI * 0.5);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = '#4b5563';
          ctx.lineWidth = 0.6;
          ctx.stroke();
        }

        ctx.restore();
        ctx.restore();
      }

      ctx.restore();
    }
  }

  class Submarine {
    constructor(terrain) {
      this.terrain = terrain;
      // نقطة بداية اللعبة: مياه مفتوحة آمنة غرب الصخور مع مساحة واسعة للدوران 360°
      this.x = 8500;
      this.y = 500;
      this.vx = 0;
      this.vy = 0;
      this.angle = Math.PI;
      this.angularVelocity = 0;
      this.occupied = false;
      this.lightsOn = true;
      this.timer = 0;
      // موضع مصباح الكشاف الفعلي تحت القبة الزجاجية الأكريليكية
      this.lampLocalX = 86;
      this.lampLocalY = 16;
      // نظام ضغط الهيكل، السحق الفيزيائي، والدم
      this.health = 100;
      this.isCrushed = false;
      this.crushAnim = 0;
      this.crushTimer = 0;
      this.bloodPlume = [];
      this.cracks = [];
      this.warningAudio = null;
      this.warningSource = null;
      this.warningGain = null;
      this.warningBuffer = null;
      this.warningAudioCtx = null;
      this.warningBus = null;
      this.warningPlaying = false;
      this.lastWarnTime = 0;
      // نظام الدفع والسرعة التدريجية
      this.throttleLevel = 0; // -1, 0, 1, 2, 3, 4
      this.thrustSpeed = 0;
      this.propellerAngle = 0;
      this.propellerSpeed = 0;
      this.bubbleTrail = new ObjectPool(() => ({ x: 0, y: 0, alpha: 0, r: 0 }), 96);
      this.motes = [];
      for (let i = 0; i < Quality.q.subMotes; i++) {
        this.motes.push({
          x: this.x + (Math.random() - 0.5) * 850,
          y: this.y + (Math.random() - 0.5) * 850,
          vx: (Math.random() - 0.5) * 3,
          vy: -1.5 - Math.random() * 2.5,
          r: 1.0 + Math.random() * 1.4
        });
      }
    }

    update(dt, joystick, throttleLevel) {
      this.timer += dt;
      if (typeof throttleLevel === 'number') this.throttleLevel = throttleLevel;

      // انضغاط وسحق الغواصة فيزيائياً مع انتشار سحاب الدم
      if (this.isCrushed) {
        this.crushTimer += dt;
        this.crushAnim = Math.min(1, this.crushAnim + dt * 1.8);
        this.thrustSpeed = 0;
        this.vx *= Math.exp(-3.0 * dt);
        this.vy = Math.min(45, this.vy + 30 * dt);
        this.x += this.vx * dt;
        this.y += this.vy * dt;

        // إطلاق الدماء من شقوق الهيكل بعد ثانية من الانسحاق
        if (this.crushTimer >= 0.8 && this.bloodPlume.length < 24) {
          for (let i = 0; i < 3; i++) {
            this.bloodPlume.push({
              x: this.x + (Math.random() - 0.5) * 20,
              y: this.y + (Math.random() - 0.5) * 15,
              vx: (Math.random() - 0.5) * 12,
              vy: -10 - Math.random() * 15,
              r: 3 + Math.random() * 5,
              a: 0.85
            });
          }
        }
        for (const bp of this.bloodPlume) {
          bp.x += bp.vx * dt;
          bp.y += bp.vy * dt;
          bp.r += 3.5 * dt;
          bp.a -= 0.18 * dt;
        }
        return;
      }

      // حساب عمق الغواصة ومقاومة الضغط
      const depthM = Math.max(0, (this.y - WORLD.WATER_Y) / WORLD.PIXELS_PER_METER);
      if (depthM >= 500) {
        const overDepth = depthM - 500;
        const dmgRate = 3.2 * (1 + overDepth / 65);
        this.health = Math.max(0, this.health - dmgRate * dt);

        if (Math.random() < 0.12 && this.cracks.length < 18) {
          this.cracks.push({
            x: 20 + Math.random() * 60,
            y: (Math.random() - 0.5) * 35,
            len: 6 + Math.random() * 14,
            ang: Math.random() * Math.PI * 2
          });
        }

        if (this.health <= 0) {
          this.isCrushed = true;
          this.lightsOn = false; // انطفاء ضوء وكشاف الغواصة فوراً عند سحقها
          if (this.warningAudio) { try { this.warningAudio.pause(); } catch (_) {} }
        }
      }

      // صوت إنذار الضغط المعتدل الهادئ
      if (this.occupied && depthM >= 440 && !this.isCrushed) {
        if (!this.warningPlaying && this.warningBuffer && this.warningAudioCtx) {
          try {
            this.warningSource = this.warningAudioCtx.createBufferSource();
            this.warningGain = this.warningAudioCtx.createGain();

            this.warningSource.buffer = this.warningBuffer;
            this.warningSource.loop = true;
            this.warningGain.gain.value = 0.28;

            this.warningSource.connect(this.warningGain);
            this.warningGain.connect(
              this.warningBus || this.warningAudioCtx.destination
            );

            this.warningSource.start();
            this.warningPlaying = true;
          } catch (err) {
            console.error(
              '[Audio] warning.mp3 playback failed:',
              err
            );
            this.warningSource = null;
            this.warningGain = null;
            this.warningPlaying = false;
          }
        }
      } else if (this.warningPlaying) {
        try {
          if (this.warningSource) {
            this.warningSource.stop();
            this.warningSource.disconnect();
          }
        } catch (_) {}

        try {
          if (this.warningGain) {
            this.warningGain.disconnect();
          }
        } catch (_) {}

        this.warningSource = null;
        this.warningGain = null;
        this.warningPlaying = false;
      }

      // 1. نظام الدوران السلس والبطيء عبر العصا اليسرى مع Dead-zone
      if (this.occupied) {
        if (joystick.force > 0.14) {
          const targetAngle = Math.atan2(joystick.dirY, joystick.dirX);
          const curAngle = Number.isFinite(this.angle) ? this.angle : targetAngle;
          const diff = Math.atan2(Math.sin(targetAngle - curAngle), Math.cos(targetAngle - curAngle));
          // تسارع دوراني هادئ وسلس (عزم عطالة مائي)
          const targetAngVel = Math.sign(diff) * Math.min(1.45, Math.abs(diff) * 2.4);
          this.angularVelocity += (targetAngVel - this.angularVelocity) * (1 - Math.exp(-4.5 * dt));
        } else {
          // تباطؤ دوراني تدريجي عند ترك العصا
          this.angularVelocity += (0 - this.angularVelocity) * (1 - Math.exp(-6.0 * dt));
        }
        this.angle += this.angularVelocity * dt;

        // 2. سرعات الدفع التدريجية: IDLE=0, x1=55, x2=115, x3=175, x4=235, REV=-60
        const speedMap = { '-1': -60, '0': 0, '1': 55, '2': 115, '3': 175, '4': 235 };
        const targetThrust = speedMap[String(this.throttleLevel)] || 0;
        this.thrustSpeed += (targetThrust - this.thrustSpeed) * (1 - Math.exp(-2.6 * dt));

        // تطبيق متجهات الدفع والمقاومة المائية
        const moveAngle = Number.isFinite(this.angle) ? this.angle : 0;
        this.vx += Math.cos(moveAngle) * this.thrustSpeed * dt * 2.2;
        this.vy += Math.sin(moveAngle) * this.thrustSpeed * dt * 2.2;

        // سرعة المروحة مرتبطة بالدفع الفعلي (عكسية عند الرجوع وتتباطأ تدريجياً)
        const targetPropSpd = (this.thrustSpeed / 235) * 36;
        this.propellerSpeed += (targetPropSpd - this.propellerSpeed) * (1 - Math.exp(-4.0 * dt));
        this.propellerAngle += this.propellerSpeed * dt;

        // فقاعات الدفع تخرج دائماً من فوهة المحرك النفاث في المؤخرة دون قفز للمقدمة
        if (Math.abs(this.thrustSpeed) > 15) {
          const cosA = Math.cos(this.angle), sinA = Math.sin(this.angle);
          const bx = this.x - cosA * 122;
          const by = this.y - sinA * 122;
          if (by >= WORLD.WATER_Y && Math.random() < 0.45) {
            const nb = this.bubbleTrail.obtain();
            if (nb) { nb.x = bx; nb.y = by; nb.alpha = 0.85; nb.r = Math.random() * 2.6 + 1.2; }
          }
        }
      } else {
        this.propellerSpeed += (0 - this.propellerSpeed) * (1 - Math.exp(-3.0 * dt));
        this.propellerAngle += this.propellerSpeed * dt;
      }

      const waterDrag = Math.exp(-1.85 * dt);
      this.vx *= waterDrag;
      this.vy *= waterDrag;

      // تقسيم الخطوة الزمنية (Sub-stepping) لمنع الاختراق النفقي عند السرعات العالية
      const disp = Math.hypot(this.vx * dt, this.vy * dt);
      const subSteps = Math.min(6, Math.max(1, Math.ceil(disp / 16)));
      const sdt = dt / subSteps;

      for (let s = 0; s < subSteps; s++) {
        this.x += this.vx * sdt;
        this.y += this.vy * sdt;
        this._resolveCollisions();
      }

      this.bubbleTrail.forEachActive((b) => {
        b.y -= 10 * dt;
        b.alpha -= 0.65 * dt;
        // تتلاشى الفقاعة فور ملامسة سطح الماء
        if (b.alpha <= 0 || b.y < WORLD.WATER_Y) this.bubbleTrail.release(b);
      });

      // طفو وانسياب الحبيبات في مياه البحر مستقلة تماماً عن حركة الكشاف
      for (const m of this.motes) {
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        if (Math.hypot(m.x - this.x, m.y - this.y) > 550) {
          m.x = this.x + (Math.random() - 0.5) * 850;
          m.y = this.y + (Math.random() - 0.5) * 850;
        }
      }
    }

    _resolveCollisions() {
      const cosA = Math.cos(this.angle), sinA = Math.sin(this.angle);
      // مجسم كبسولي متين يغطي كامل الهيكل والمحرك والبرج بدقة 100%
      const colliders = [
        { ox: cosA * 92, oy: sinA * 92, r: 20 },                  // مقدمة السونار
        { ox: cosA * 45, oy: sinA * 45, r: 27 },                  // النصف الأمامي
        { ox: 0, oy: 0, r: 29 },                                   // بطن الغواصة
        { ox: -cosA * 48, oy: -sinA * 48, r: 26 },                // النصف الخلفي
        { ox: -cosA * 98, oy: -sinA * 98, r: 22 },                // المحرك النفاث
        { ox: cosA * 36 + sinA * 35, oy: sinA * 36 - cosA * 35, r: 16 }, // قاعدة البرج
        { ox: cosA * 38 + sinA * 62, oy: sinA * 38 - cosA * 62, r: 9 }   // صاري البيريسكوب
      ];

      let wallImpactSpeed = 0;
      let isTouchingWall = false;

      for (let i = 0; i < colliders.length; i++) {
        const c = colliders[i];
        const px = this.x + c.ox;
        const py = this.y + c.oy;

        // 1. تصادم الجدار الصخري السحيق (عمق 100م فأكثر)
        if (py >= 995) {
          const wallX = this.terrain.getWallX(py);
          if (px + c.r > wallX) {
            const penX = px + c.r - wallX;
            this.x -= penX;
            isTouchingWall = true;
            wallImpactSpeed = Math.max(wallImpactSpeed, Math.abs(this.vx));
            if (this.vx > 0) this.vx = 0;
          }
        }

        // 2. تصادم القاع (المنحدر للسطح، وقاع الخندق السحيق للأعماق)
        if (py < 1000) {
          const gY = this.terrain.getHeightAt(this.x + c.ox);
          if (py + c.r > gY) {
            this.y -= (py + c.r - gY);
            if (this.vy > 0) this.vy = 0;
          }
        } else {
          // حصر فحص القاع في عمق الخندق فقط دون مساس منسوب المنحدر
          const floorX = Math.min(WORLD.WALL_X - 120, this.x + c.ox);
          const floorY = this.terrain.getHeightAt(floorX);
          if (py + c.r > floorY) {
            this.y -= (py + c.r - floorY);
            if (this.vy > 0) this.vy = 0;
          }
        }

        // 3. تصادم الصخور الضحلة (الحاجز الصخري)
        const rockY = this.terrain.getRockSurfaceAt(this.x + c.ox);
        if (rockY !== null && py + c.r > rockY) {
          this.y -= (py + c.r - rockY);
          if (this.vy > 0) this.vy = 0;
        }
      }

      // إطلاق صوت الاصطدام فقط عند بداية الصدمة وليس بالضغط المستمر
      if (isTouchingWall) {
        if (!this._wasTouchingWall && wallImpactSpeed > 22 && this.engineAudio && this.engineAudio.mgr) {
          this.engineAudio.mgr.playHullImpact(wallImpactSpeed);
        }
        this._wasTouchingWall = true;
      } else {
        this._wasTouchingWall = false;
      }

      // 4. الحدود العالمية الصارمة (يسار، يمين، سطح، قاع) بأبعاد الغواصة
      const rotLift = 115 * Math.abs(sinA);
      const minSurfaceY = WORLD.WATER_Y + Math.max(26, rotLift);
      if (this.y < minSurfaceY) {
        this.y = minSurfaceY;
        if (this.vy < 0) this.vy = 0;
      }
      const maxDeepY = WORLD.HEIGHT - 45;
      if (this.y > maxDeepY) {
        this.y = maxDeepY;
        if (this.vy > 0) this.vy = 0;
      }
      const reachRear = Math.max(35, Math.abs(cosA) * 110);
      if (this.x < reachRear) {
        this.x = reachRear;
        if (this.vx < 0) this.vx = 0;
      }
      const maxWorldX = WORLD.WIDTH - 65;
      if (this.x > maxWorldX) {
        this.x = maxWorldX;
        if (this.vx > 0) this.vx = 0;
      }
    }

    // وميض اللمبة الحمراء البصري الهادئ (يعمل ذاتياً وبصمت تام كل 3 ثوانٍ)
    _strobeValue() {
      const strobeCycle = (this.timer % 3.0);
      const isFlash = (strobeCycle >= 0.1 && strobeCycle < 0.3);
      return isFlash ? Math.sin(((strobeCycle - 0.1) / 0.2) * Math.PI) : 0;
    }

    drawSearchlightIllumination(lCtx, terrain, waterPath) {
      if (!this.lightsOn) {
        this.lightData = null;
        this._geomKey = null;
        return;
      }
      const safeAngle = Number.isFinite(this.angle) ? this.angle : 0;
      const cosA = Math.cos(safeAngle), sinA = Math.sin(safeAngle);
      const range = 660;
      const coneAngle = 0.38;

      // مراعاة انعكاس الإحداثي الرأسي عند التوجه لليسار ليتطابق الشعاع مع العدسة 100%
      const flippedLampY = (cosA < 0) ? -this.lampLocalY : this.lampLocalY;
      let worldEmitX = this.x + cosA * this.lampLocalX - sinA * flippedLampY;
      let worldEmitY = this.y + sinA * this.lampLocalX + cosA * flippedLampY;

      // حماية نقطة انبعاث الكشاف من التداخل داخل الجدران لمنع انطفاء وارتجاف الضوء
      if (worldEmitY >= 1000) {
        const wX = terrain.getWallX(worldEmitY);
        if (worldEmitX >= wX - 6) worldEmitX = wX - 6;
      } else {
        const gY = terrain.getHeightAt(worldEmitX);
        if (worldEmitY >= gY - 6) worldEmitY = gY - 6;
        const rY = terrain.getRockSurfaceAt(worldEmitX);
        if (rY !== null && worldEmitY >= rY - 6) worldEmitY = rY - 6;
      }
      const conePad = range + 30;

      const geomKey = Math.round(worldEmitX) + '|' + Math.round(worldEmitY) + '|' + Math.round(safeAngle * 512) + '|' + Quality.q.subRays;
      if (geomKey !== this._geomKey) {
        this._geomKey = geomKey;
        const rays = Quality.q.subRays;
        const step = 5;
        const hitPoints = [];
        let centerHitX = 0, centerHitY = 0;
        let isCenterHit = false;

        for (let i = 0; i <= rays; i++) {
          const currentAngle = safeAngle - coneAngle + (i / rays) * (coneAngle * 2);
          let rayX = worldEmitX, rayY = worldEmitY, dist = 0;
          const cosA = Math.cos(currentAngle), sinA = Math.sin(currentAngle);
          let hit = false;

          while (dist < range) {
            rayX += cosA * step;
            rayY += sinA * step;
            dist += step;

            let hitObj = false;
            if (rayY >= 1000) {
              const wallX = terrain.getWallX(rayY);
              if (rayX >= wallX) {
                hitObj = true;
              } else if (rayY >= 60000) {
                const floorX = Math.min(WORLD.WALL_X - 120, rayX);
                if (rayY >= terrain.getHeightAt(floorX)) hitObj = true;
              }
            } else {
              const gY = terrain.getHeightAt(rayX);
              const rY = terrain.getRockSurfaceAt(rayX);
              const surfaceY = rY !== null ? Math.min(gY, rY) : gY;
              if (rayY >= surfaceY) hitObj = true;
            }

            if (hitObj) {
              let low = dist - step, high = dist;
              for (let b = 0; b < 4; b++) {
                let mid = (low + high) / 2;
                let mx = worldEmitX + cosA * mid;
                let my = worldEmitY + sinA * mid;
                let mHit = false;
                if (my >= 1000) {
                  const mWallX = terrain.getWallX(my);
                  if (mx >= mWallX) {
                    mHit = true;
                  } else if (my >= 60000) {
                    const mFloorX = Math.min(WORLD.WALL_X - 120, mx);
                    if (my >= terrain.getHeightAt(mFloorX)) mHit = true;
                  }
                } else {
                  const mgY = terrain.getHeightAt(mx);
                  const mrY = terrain.getRockSurfaceAt(mx);
                  const mSurf = mrY !== null ? Math.min(mgY, mrY) : mgY;
                  if (my >= mSurf) mHit = true;
                }
                if (mHit) high = mid; else low = mid;
              }
              const safeDist = Math.max(8, high);
              rayX = worldEmitX + cosA * safeDist;
              rayY = worldEmitY + sinA * safeDist;
              hit = true;
              break;
            }
          }
          hitPoints.push({ x: rayX, y: rayY, hit: hit });
          if (i === Math.floor(rays / 2) && hit) {
            centerHitX = rayX; centerHitY = rayY; isCenterHit = true;
          }
        }

        this.lightData = { worldEmitX, worldEmitY, hitPoints, isCenterHit, centerHitX, centerHitY, range, rays, safeAngle, coneAngle };

        if (!this._lightConeLayer) {
          this._lightConeLayer = document.createElement('canvas');
          this._lightConeCtx = this._lightConeLayer.getContext('2d');
        }
        if (this._lightConeLayer.width !== conePad * 2 || this._lightConeLayer.height !== conePad * 2) {
          this._lightConeLayer.width = conePad * 2;
          this._lightConeLayer.height = conePad * 2;
        }

        const cc = this._lightConeCtx;
        cc.setTransform(1, 0, 0, 1, 0, 0);
        cc.globalCompositeOperation = 'source-over';
        cc.clearRect(0, 0, conePad * 2, conePad * 2);
        cc.translate(conePad - worldEmitX, conePad - worldEmitY);

        cc.save();
        cc.beginPath();
        cc.moveTo(worldEmitX, worldEmitY);
        for (const hp of hitPoints) cc.lineTo(hp.x, hp.y);
        cc.closePath();

        // تدرج ضوئي سينمائي قوي ومستمر يكشف سطح الصخور والجدران بوضوح طبيعي
        const coneGrad = cc.createRadialGradient(worldEmitX, worldEmitY, 4, worldEmitX, worldEmitY, range);
        coneGrad.addColorStop(0.0, 'rgba(255, 255, 255, 1.0)');
        coneGrad.addColorStop(0.12, 'rgba(215, 245, 255, 0.95)');
        coneGrad.addColorStop(0.48, 'rgba(125, 205, 255, 0.68)');
        coneGrad.addColorStop(0.82, 'rgba(45, 140, 225, 0.32)');
        coneGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
        cc.fillStyle = coneGrad;
        cc.fill();
        cc.restore();

        this._applyConicMask(cc, worldEmitX, worldEmitY, safeAngle, coneAngle);
      }

      // توهج بؤري مدمج لعدسة المصباح فقط بدون تسريب دائري شاذ للخلف
      lCtx.save();
      const emitGrad = lCtx.createRadialGradient(worldEmitX, worldEmitY, 1, worldEmitX, worldEmitY, 14);
      emitGrad.addColorStop(0.0, 'rgba(255, 255, 255, 0.95)');
      emitGrad.addColorStop(0.5, 'rgba(180, 230, 255, 0.45)');
      emitGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
      lCtx.fillStyle = emitGrad;
      lCtx.beginPath();
      lCtx.arc(worldEmitX, worldEmitY, 14, 0, Math.PI * 2);
      lCtx.fill();
      lCtx.restore();

      if (this._lightConeLayer) {
        lCtx.drawImage(this._lightConeLayer, worldEmitX - conePad, worldEmitY - conePad);
      }

      // زمن الإطار لتنعيم الانعكاس (يُحسب مرة واحدة في أول رسم بالإطار)
  // انعكاس سطحي حقيقي يسقط على الصخور بحرية دون اقتصاص
  const dtB = this._lastBT ? Math.min(0.05, (performance.now() - this._lastBT) / 1000) : 0.016;
  this._lastBT = performance.now();
  lCtx.save();
  lCtx.globalCompositeOperation = 'screen';
  this.drawSurfaceBounce(lCtx, this.lightData, dtB);
  lCtx.restore();

  // --- إضاءة الغواصة الذاتية على الـ Light Map مرتكزة بدقة على مركز الغواصة ---
  lCtx.save();
  lCtx.translate(this.x, this.y);
  lCtx.rotate(safeAngle);
  if (Math.cos(safeAngle) < 0) lCtx.scale(1, -1);
  lCtx.globalCompositeOperation = 'screen';

  // 1. وميض منارة الاستكشاف العنبرية البرتقالية الواضح والدافئ
  const strobeVal = this._strobeValue();
  if (strobeVal > 0.05) {
    const radius = 88 * strobeVal;
    const sGlow = lCtx.createRadialGradient(38, -65, 1, 38, -65, radius);
    sGlow.addColorStop(0.0, 'rgba(255, 160, 20, 0.88)');
    sGlow.addColorStop(0.35, 'rgba(255, 115, 0, 0.45)');
    sGlow.addColorStop(0.8, 'rgba(210, 75, 0, 0.12)');
    sGlow.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
    lCtx.fillStyle = sGlow;
    lCtx.beginPath(); lCtx.arc(38, -65, radius, 0, Math.PI * 2); lCtx.fill();
  }

  // 2. توهج مقصورة قبة المراقبة الأكريليك الأمامية
  const domeGlow = lCtx.createRadialGradient(74, 0, 2, 74, 0, 48);
  domeGlow.addColorStop(0.0, 'rgba(255, 195, 75, 0.55)');
  domeGlow.addColorStop(0.45, 'rgba(235, 130, 25, 0.15)');
  domeGlow.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
  lCtx.fillStyle = domeGlow;
  lCtx.beginPath(); lCtx.arc(74, 0, 48, 0, Math.PI * 2); lCtx.fill();

  // 3. توهج مصابيح فحص البطن ومسح القاع على Light Map (ينشط تدريجياً في الأعماق والظلام فقط)
  if (this.lightsOn) {
    const depthM = Math.max(0, (this.y - WORLD.WATER_Y) / WORLD.PIXELS_PER_METER);
    const depthDarkness = Math.max(0, Math.min(1.0, (depthM - 12) / 60));
    if (depthDarkness > 0.05) {
      const bAlpha = depthDarkness * 0.45;
      const bellyGlow1 = lCtx.createRadialGradient(44, 28, 1, 44, 38, 55);
      bellyGlow1.addColorStop(0.0, `rgba(180, 230, 255, ${bAlpha.toFixed(3)})`);
      bellyGlow1.addColorStop(0.5, `rgba(40, 130, 210, ${(bAlpha * 0.35).toFixed(3)})`);
      bellyGlow1.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
      lCtx.fillStyle = bellyGlow1;
      lCtx.beginPath(); lCtx.arc(44, 36, 55, 0, Math.PI * 2); lCtx.fill();

      const bellyGlow2 = lCtx.createRadialGradient(-8, 27, 1, -8, 36, 48);
      bellyGlow2.addColorStop(0.0, `rgba(180, 230, 255, ${(bAlpha * 0.85).toFixed(3)})`);
      bellyGlow2.addColorStop(0.5, `rgba(40, 130, 210, ${(bAlpha * 0.28).toFixed(3)})`);
      bellyGlow2.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
      lCtx.fillStyle = bellyGlow2;
      lCtx.beginPath(); lCtx.arc(-8, 34, 48, 0, Math.PI * 2); lCtx.fill();
    }
  }

  lCtx.restore();
}

    // قناع زاوي cos موحد (تدرج دائري حقيقي يُحسب لكل بكسل) — يمنع التشققات في أي لوحة مؤقتة
    _applyConicMask(c, emitX, emitY, safeAngle, coneAngle) {
      if (!c.createConicGradient) return; // fallback: تدرج شعاعي ناعم بدون قناع
      c.globalCompositeOperation = 'destination-in';
      const coneSpan = (coneAngle * 2) / (Math.PI * 2);
      const conicMask = c.createConicGradient(safeAngle - coneAngle, emitX, emitY);
      for (let s = 0; s <= 24; s++) {
        const t = s / 24;
        const aa = Math.cos(Math.abs(t - 0.5) * Math.PI);
        conicMask.addColorStop(t * coneSpan, `rgba(255, 255, 255, ${aa.toFixed(3)})`);
      }
      c.fillStyle = conicMask;
      c.fill();
      c.globalCompositeOperation = 'source-over';
    }



// إضاءة سطحية متوزعة خفيفة جداً تعانق كامل تضاريس الجدار دون دوائر ودون خطوط مصطنعة
    drawSurfaceBounce(ctx, lightOrX, dtOrY, maybeDt) {
      const ld = (typeof lightOrX === 'object' && lightOrX !== null) ? lightOrX : this.lightData;
      const dt = ((typeof lightOrX === 'object') ? dtOrY : maybeDt) || 0.016;
      if (!ld || !ld.hitPoints || ld.hitPoints.length === 0) return;

      const { hitPoints, worldEmitX, worldEmitY, range } = ld;
      const hits = [];
      for (let i = 0; i < hitPoints.length; i++) {
        const p = hitPoints[i];
        const isHit = (p.hit !== undefined) ? p.hit : (Math.hypot(p.x - worldEmitX, p.y - worldEmitY) < range - 8);
        if (isHit) hits.push(p);
      }

      const hasHits = hits.length >= 2;
      if (!this._bounceInit) { this._bounceA = 0; this._bounceInit = true; }
      this._bounceA = hasHits ? Math.min(1, this._bounceA + 7 * dt) : Math.max(0, this._bounceA - 7 * dt);
      if (this._bounceA <= 0.02 || !hasHits) return;

      const mid = hits[Math.floor(hits.length / 2)];
      const dist = Math.hypot(mid.x - worldEmitX, mid.y - worldEmitY);
      const dNorm = Math.max(0, Math.min(1, dist / range));

      // اضمحلال هادئ: خفيف جداً عند البعد ويتجمع ويقوى بنعومة عند القرب
      const alpha = Math.pow(1 - dNorm, 2.0) * 0.22 * this._bounceA;
      if (alpha < 0.01) return;

      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      // 1. تشتت سطحي عريض فائق النعومة والخفة يغطي كامل المساحة المضاءة
      ctx.beginPath();
      ctx.moveTo(hits[0].x, hits[0].y);
      for (let i = 1; i < hits.length; i++) ctx.lineTo(hits[i].x, hits[i].y);
      ctx.strokeStyle = `rgba(70, 160, 235, ${(alpha * 0.35).toFixed(3)})`;
      ctx.lineWidth = Math.max(16, Math.min(34, (1 - dNorm) * 14 + 18));
      ctx.stroke();

      // 2. توهج ملامسة ناعم جداً على سطح الصخور
      ctx.beginPath();
      ctx.moveTo(hits[0].x, hits[0].y);
      for (let i = 1; i < hits.length; i++) ctx.lineTo(hits[i].x, hits[i].y);
      ctx.strokeStyle = `rgba(160, 225, 255, ${(alpha * 0.70).toFixed(3)})`;
      ctx.lineWidth = Math.max(5, Math.min(11, (1 - dNorm) * 4 + 6));
      ctx.stroke();

      ctx.restore();
    }



    drawCrushedMetalBall(ctx) {
      ctx.save();
      // كرة سكراب معدنية مشوهة مكسورة ومضغوطة
      ctx.fillStyle = '#16191c';
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, Math.PI * 2);
      ctx.fill();

      // انبعاجات صفائح التيتانيوم المطعوجة
      ctx.fillStyle = '#3a444d';
      ctx.beginPath();
      ctx.moveTo(-14, -10); ctx.lineTo(2, -16); ctx.lineTo(15, -6);
      ctx.lineTo(10, 12); ctx.lineTo(-8, 14); ctx.lineTo(-16, 2);
      ctx.closePath(); ctx.fill();

      // شقوق سوداء غائرة وزجاج القبة المحطم المنطفئ
      ctx.strokeStyle = '#080a0c'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-12, -14); ctx.lineTo(4, 12);
      ctx.moveTo(12, -8); ctx.lineTo(-10, 10);
      ctx.stroke();

      // شظايا زجاج أكريليك متكسرة ومظلمة
      ctx.fillStyle = 'rgba(40, 70, 90, 0.6)';
      ctx.beginPath(); ctx.arc(4, -3, 6, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }

    drawAdditiveEffects(ctx, waterPath) {
      ctx.save();
      ctx.globalCompositeOperation = 'screen';

      // 1. تأثيرات الكشاف الحجمية والانعكاس (تُرسم فوق المشهد لتبدو مضيئة وحقيقية)
      if (this.lightsOn && this.lightData) {
        const { worldEmitX, worldEmitY, hitPoints, isCenterHit, centerHitX, centerHitY, range, rays, safeAngle, coneAngle } = this.lightData;
        
        // شعاع ضبابي حجمي في لوحة مستقلة لا تمس لوحة كاش الإضاءة الرئيسية
        if (!this._fogLayer) {
          this._fogLayer = document.createElement('canvas');
          this._fogCtx = this._fogLayer.getContext('2d');
        }
        const fogPad = range + 30;
        if (this._fogLayer.width !== fogPad * 2 || this._fogLayer.height !== fogPad * 2) {
          this._fogLayer.width = fogPad * 2;
          this._fogLayer.height = fogPad * 2;
        }
        const fc = this._fogCtx;
        fc.setTransform(1, 0, 0, 1, 0, 0);
        fc.globalCompositeOperation = 'source-over';
        fc.clearRect(0, 0, fogPad * 2, fogPad * 2);
        fc.translate(fogPad - worldEmitX, fogPad - worldEmitY);

        fc.save();
        fc.beginPath();
        fc.moveTo(worldEmitX, worldEmitY);
        for (const hp of hitPoints) {
          fc.lineTo(hp.x, hp.y);
        }
        fc.closePath();

        const fogGrad = fc.createRadialGradient(worldEmitX, worldEmitY, 10, worldEmitX, worldEmitY, range);
        fogGrad.addColorStop(0.0, 'rgba(40, 140, 255, 0.15)');
        fogGrad.addColorStop(0.6, 'rgba(15, 70, 150, 0.05)');
        fogGrad.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
        fc.fillStyle = fogGrad;
        fc.fill();
        fc.restore();

        this._applyConicMask(fc, worldEmitX, worldEmitY, safeAngle, coneAngle);

        ctx.drawImage(this._fogLayer, worldEmitX - fogPad, worldEmitY - fogPad);

        // إضاءة العوالق المائية (Marine Snow)
        const depthM = Math.max(0, (this.y - WORLD.WATER_Y) / WORLD.PIXELS_PER_METER);
        const depthIntensity = Math.min(1.0, 0.15 + Math.pow(Math.min(1.0, depthM / 65), 1.6) * 0.85);
        for (const m of this.motes) {
          const dx = m.x - worldEmitX;
          const dy = m.y - worldEmitY;
          const dist = Math.hypot(dx, dy);
          if (dist > 15 && dist < range) {
            const ang = Math.atan2(dy, dx);
            const diff = Math.abs(Math.atan2(Math.sin(ang - safeAngle), Math.cos(ang - safeAngle)));
            if (diff < coneAngle) {
              const alpha = (1 - dist / range) * (1 - diff / coneAngle) * 0.95 * depthIntensity;
              ctx.fillStyle = `rgba(255, 255, 255, ${alpha.toFixed(3)})`;
              ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2); ctx.fill();
            }
          }
        }
      }

      ctx.restore();
    }
    draw(ctx) {
      ctx.save();
      ctx.translate(this.x, this.y);
      const safeAngle = Number.isFinite(this.angle) ? this.angle : 0;
      ctx.rotate(safeAngle);
      if (Math.cos(safeAngle) < 0) ctx.scale(1, -1);

      // تحول الغواصة فوراً لكتلة معدنية كروية مسحوقة تماماً بدون اهتزاز أو رقص
      if (this.isCrushed) {
        this.lightsOn = false;
        this.drawCrushedMetalBall(ctx);
        ctx.restore();
        return;
      }

      // حساب معامل الظلام الحقيقي لضبط توهج المصابيح ومنع التوهج الزائد على السطح
      const depthM = Math.max(0, (this.y - WORLD.WATER_Y) / WORLD.PIXELS_PER_METER);
      const depthDarkness = Math.max(0, Math.min(1.0, (depthM - 10) / 65));
      const bloomAlpha = Math.pow(depthDarkness, 1.4);
      const reflectAlpha = 0.08 + depthDarkness * 0.72;

      // ---------------------------------------------------------------------
      // 1. الزعانف الخلفية وأسطح التوجيه (Cruciform Stabilizer Fins)
      // ---------------------------------------------------------------------
      ctx.save();
      // الزعنفة العلوية الانسيابية الممتدة نحو فوهة المحرك
      const finGradTop = ctx.createLinearGradient(-80, -25, -112, -40);
      finGradTop.addColorStop(0.0, '#3d4855');
      finGradTop.addColorStop(0.5, '#2b343e');
      finGradTop.addColorStop(1.0, '#192027');
      ctx.fillStyle = finGradTop;
      ctx.beginPath();
      ctx.moveTo(-76, -26);
      ctx.lineTo(-106, -40);
      ctx.lineTo(-114, -14);
      ctx.lineTo(-92, -18);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#576574';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // الزعنفة السفلية الموازية
      const finGradBot = ctx.createLinearGradient(-80, 25, -112, 40);
      finGradBot.addColorStop(0.0, '#3d4855');
      finGradBot.addColorStop(0.5, '#242d36');
      finGradBot.addColorStop(1.0, '#151b22');
      ctx.fillStyle = finGradBot;
      ctx.beginPath();
      ctx.moveTo(-76, 26);
      ctx.lineTo(-106, 40);
      ctx.lineTo(-114, 14);
      ctx.lineTo(-92, 18);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#47535e';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();

      // ---------------------------------------------------------------------
      // 2. فوهة المحرك النفاث ومروحة الدفع البرونزية (Kort Nozzle & Propeller)
      // ---------------------------------------------------------------------
      ctx.save();
      ctx.translate(-118, 0);

      // فوهة Kort Nozzle هيدروديناميكية متطورة ذات تدفق حلقي
      const nozzleGrad = ctx.createLinearGradient(-10, -21, 10, 21);
      nozzleGrad.addColorStop(0.0, '#4b5768');
      nozzleGrad.addColorStop(0.3, '#1c242c');
      nozzleGrad.addColorStop(0.8, '#10171d');
      nozzleGrad.addColorStop(1.0, '#2d3744');
      ctx.fillStyle = nozzleGrad;
      ctx.beginPath();
      ctx.roundRect(-8, -20, 15, 40, 4);
      ctx.fill();
      ctx.strokeStyle = '#637282';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      // شفرات توجيه التدفق الثابتة (Stator Vanes) داخل الفوهة
      ctx.fillStyle = '#0d1318';
      ctx.fillRect(-4, -17, 8, 34);
      ctx.strokeStyle = '#384350';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(-4, -8); ctx.lineTo(4, -8);
      ctx.moveTo(-4, 0); ctx.lineTo(4, 0);
      ctx.moveTo(-4, 8); ctx.lineTo(4, 8);
      ctx.stroke();

      // مروحة دفع برونزية متطورة رباعية الشفرات (Scimitar Propeller)
      const pSpin = this.propellerAngle;
      for (let b = 0; b < 4; b++) {
        const bAng = pSpin + (b * Math.PI * 0.5);
        const bSpan = Math.sin(bAng) * 15.5;
        const bThick = Math.cos(bAng) * 4.5;

        const propGrad = ctx.createLinearGradient(-5, bSpan - 4, 3, bSpan + 4);
        propGrad.addColorStop(0.0, '#f39c12');
        propGrad.addColorStop(0.4, '#e67e22');
        propGrad.addColorStop(1.0, '#78281f');
        ctx.fillStyle = propGrad;

        ctx.beginPath();
        ctx.ellipse(-1.5, bSpan, Math.max(1.6, Math.abs(bThick)), 4.8, bAng * 0.35, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 230, 150, 0.35)';
        ctx.lineWidth = 0.6;
        ctx.stroke();
      }

      // محور الدوران الانسيابي المشطوف مع حلقة تيتانيوم
      ctx.fillStyle = '#2c3e50';
      ctx.fillRect(-2, -5, 3, 10);
      const spinnerGrad = ctx.createLinearGradient(-1, -4, -10, 4);
      spinnerGrad.addColorStop(0.0, '#f1c40f');
      spinnerGrad.addColorStop(0.5, '#d35400');
      spinnerGrad.addColorStop(1.0, '#571c14');
      ctx.fillStyle = spinnerGrad;
      ctx.beginPath();
      ctx.moveTo(-1, 0);
      ctx.lineTo(-10, -4.0);
      ctx.lineTo(-10, 4.0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // ---------------------------------------------------------------------
      // 3. زلاجات الهبوط التيتانيوم وخزان الطفو (Skids & Ballast Pod)
      // ---------------------------------------------------------------------
      ctx.save();
      // دعامات الهبوط المائلة والمفصلات
      ctx.strokeStyle = '#2f3542';
      ctx.lineWidth = 3.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      // دعامة خلفية مائلة
      ctx.moveTo(-36, 26); ctx.lineTo(-42, 36);
      // دعامة أمامية مائلة
      ctx.moveTo(36, 26); ctx.lineTo(30, 36);
      ctx.stroke();

      // مفصلات التثبيت الدائرية
      ctx.fillStyle = '#57606f';
      ctx.beginPath();
      ctx.arc(-36, 26, 2.5, 0, Math.PI * 2);
      ctx.arc(36, 26, 2.5, 0, Math.PI * 2);
      ctx.fill();

      // أنبوب التزلج الرئيسي بنهاية أمامية هيدروديناميكية منحنية
      const skidGrad = ctx.createLinearGradient(-54, 34, 78, 38);
      skidGrad.addColorStop(0.0, '#3a414e');
      skidGrad.addColorStop(0.5, '#57606f');
      skidGrad.addColorStop(1.0, '#2f3542');
      ctx.strokeStyle = skidGrad;
      ctx.lineWidth = 3.6;
      ctx.beginPath();
      ctx.moveTo(-54, 36);
      ctx.lineTo(65, 36);
      ctx.quadraticCurveTo(74, 36, 78, 28);
      ctx.stroke();

      // كبسولة خزان الطفو والبطاريات الاستكشافي البرتقالي (Ballast Pod)
      const podGrad = ctx.createLinearGradient(0, 11, 0, 25);
      podGrad.addColorStop(0.0, '#ff793f');
      podGrad.addColorStop(0.45, '#ee5253');
      podGrad.addColorStop(1.0, '#b33939');
      ctx.fillStyle = podGrad;
      ctx.beginPath();
      ctx.roundRect(-24, 11, 50, 14, 7);
      ctx.fill();
      ctx.strokeStyle = '#791a1a';
      ctx.lineWidth = 1.3;
      ctx.stroke();

      // لمعان شريط السطح العلوي للخزان
      ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
      ctx.beginPath();
      ctx.roundRect(-18, 12.5, 38, 2.6, 1.3);
      ctx.fill();

      // أحزمة التثبيت الفولاذية المزدوجة
      ctx.fillStyle = '#222f3e';
      ctx.fillRect(-13, 10.5, 4, 15);
      ctx.fillRect(15, 10.5, 4, 15);
      ctx.restore();

      // ---------------------------------------------------------------------
      // 4. جسم الغواصة الموحد وانسياب البرج (Monocoque Hull & Sail Fairing)
      // ---------------------------------------------------------------------
      ctx.save();
      // هيكل انسيابي موحد يدمج البرج بسلاسة مع سقف الغواصة دون حواف مفككة
      ctx.beginPath();
      // بداية من مقدمة القوس الأمامي
      ctx.moveTo(96, -2);
      // انحناء القوس العلوي حتى مقدمة قاعدة البرج
      ctx.bezierCurveTo(94, -20, 78, -28, 62, -28.5);
      // انسياب الحافة الأمامية لبرج المراقبة (Sail Leading Edge)
      ctx.quadraticCurveTo(56, -53, 52, -53);
      // سقف برج المراقبة الأفقي
      ctx.lineTo(16, -53);
      // انحدار الحافة الخلفية لبرج المراقبة نحو ظهر الغواصة
      ctx.quadraticCurveTo(10, -51, 6, -29);
      // ظهر الغواصة المتجه نحو المؤخرة
      ctx.lineTo(-60, -29);
      // استدقاق المؤخرة المتصل بفوهة المحرك
      ctx.lineTo(-112, -14);
      ctx.lineTo(-112, 14);
      // بطن المؤخرة السفلي
      ctx.lineTo(-60, 29);
      // بطن الغواصة السفلي المتجه للأمام
      ctx.bezierCurveTo(38, 31.5, 78, 26, 96, -2);
      ctx.closePath();

      // تدرج أسطواني غني يحقق إحساس الحجم ثلاثي الأبعاد والصلابة المعدنية
      const hullGrad = ctx.createLinearGradient(0, -53, 0, 32);
      hullGrad.addColorStop(0.0, '#fff4b8'); // ضوء الحافة العلوي
      hullGrad.addColorStop(0.12, '#fed330'); // الأصفر الزاهي للاستكشاف
      hullGrad.addColorStop(0.65, '#f39c12'); // تدرج جانبي متماسك
      hullGrad.addColorStop(0.88, '#b7791f'); // ظل سفلي
      hullGrad.addColorStop(1.0, '#5a3d0f'); // عتمة بطن الغواصة
      ctx.fillStyle = hullGrad;
      ctx.fill();

      // إطار تحديد محيطي صلب بلون برونزي تيتانيوم
      ctx.strokeStyle = '#6e4a10';
      ctx.lineWidth = 2.0;
      ctx.stroke();

      // خطوط فواصل دروع التيتانيوم ومسامير التثبيت الغاطسة
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.28)';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      // درع أفقي طولي
      ctx.moveTo(-58, -16); ctx.lineTo(60, -16);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(0, 0, 0, 0.20)';
      ctx.beginPath();
      // فواصل مقاطع رأسية
      ctx.moveTo(-20, -27); ctx.lineTo(-20, 27);
      ctx.moveTo(32, -27); ctx.lineTo(32, 27);
      ctx.stroke();

      // مسامير تثبيت دقيقة على طول الفواصل
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      const rivetYs = [-20, -10, 0, 10, 20];
      for (const ry of rivetYs) {
        ctx.fillRect(-20.5, ry, 1.2, 1.2);
        ctx.fillRect(31.5, ry, 1.2, 1.2);
      }

      // رسم شقوق الضغط الواقعية على الهيكل
      if (this.cracks.length > 0) {
        ctx.strokeStyle = 'rgba(20, 10, 5, 0.85)';
        ctx.lineWidth = 1.3;
        for (const cr of this.cracks) {
          ctx.beginPath();
          ctx.moveTo(cr.x, cr.y);
          ctx.lineTo(cr.x + Math.cos(cr.ang) * cr.len, cr.y + Math.sin(cr.ang) * cr.len);
          ctx.stroke();
        }
      }
      ctx.restore();

      // ---------------------------------------------------------------------
      // 5. تفاصيل برج المراقبة وفتحة الدخول والصواري (Sail Rigging & Mast)
      // ---------------------------------------------------------------------
      ctx.save();
      // غطاء فتحة الدخول المضغوطة (Access Hatch)
      ctx.fillStyle = '#2d3436';
      ctx.beginPath();
      ctx.roundRect(22, -55.5, 22, 3.5, 1.8);
      ctx.fill();
      ctx.strokeStyle = '#636e72';
      ctx.lineWidth = 1.0;
      ctx.stroke();

      // صواري الاستشعار والاتصالات التيتانيوم
      ctx.strokeStyle = '#57606f';
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(38, -53); ctx.lineTo(38, -63);
      ctx.moveTo(46, -53); ctx.lineTo(46, -60);
      ctx.stroke();

      // منارة الأمان العنبرية البرتقالية الوامضة في قمة الصاري
      const isAmberFlash = this._strobeValue() > 0.05;
      ctx.fillStyle = isAmberFlash ? '#fff1cc' : '#d35400';
      ctx.beginPath();
      ctx.arc(38, -65, 2.8, 0, Math.PI * 2);
      ctx.fill();
      if (isAmberFlash) {
        ctx.fillStyle = 'rgba(255, 165, 2, 0.45)';
        ctx.beginPath();
        ctx.arc(38, -65, 6.5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();

      // ---------------------------------------------------------------------
      // 6. قبة المراقبة الأكريليكية البانورامية (Observation Dome)
      // ---------------------------------------------------------------------
      ctx.save();
      // حلقة تثبيت تيتانيوم ثقيلة مدمجة بالهيكل
      ctx.fillStyle = '#2d3436';
      ctx.beginPath();
      ctx.arc(74, 0, 17.5, -Math.PI * 0.45, Math.PI * 0.45);
      ctx.closePath();
      ctx.fill();

      // زجاج أكريليك بانورامي متعدد التدرجات مع إضاءة مقصورة داخلية
      const domeGlass = ctx.createLinearGradient(60, -12, 90, 12);
      domeGlass.addColorStop(0.0, 'rgba(85, 239, 196, 0.88)');
      domeGlass.addColorStop(0.5, 'rgba(9, 132, 227, 0.65)');
      domeGlass.addColorStop(0.85, 'rgba(255, 215, 0, 0.42)');
      domeGlass.addColorStop(1.0, 'rgba(10, 30, 50, 0.85)');
      ctx.fillStyle = domeGlass;
      ctx.beginPath();
      ctx.arc(74, 0, 15.5, -Math.PI * 0.45, Math.PI * 0.45);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = '#1e272e';
      ctx.lineWidth = 2.0;
      ctx.stroke();

      // لمعان انحناء زجاج القبة الخارجي (Fresnel specular arc)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(74, 0, 13, -Math.PI * 0.35, -Math.PI * 0.05);
      ctx.stroke();
      ctx.restore();

      // ---------------------------------------------------------------------
      // 7. الكشاف الرئيسي المدمج تحت القبة الزجاجية (86, 16)
      ctx.save();
      ctx.fillStyle = '#2f3542';
      ctx.beginPath();
      ctx.moveTo(76, 12); ctx.lineTo(84, 16); ctx.lineTo(76, 20);
      ctx.closePath(); ctx.fill();

      // غلاف المصباح المدرع تحت الزجاج
      ctx.fillStyle = '#1e272e';
      ctx.beginPath(); ctx.roundRect(79, 11, 7, 10, 1.8); ctx.fill();
      ctx.strokeStyle = '#57606f'; ctx.lineWidth = 1.1; ctx.stroke();

      // عدسة الكشاف الرئيسية العاكسة المتطابقة تماماً مع منبع الشعاع (86, 16)
      if (this.lightsOn) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(86, 16, 4.2, -Math.PI * 0.5, Math.PI * 0.5);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#cceeff'; ctx.lineWidth = 1.0; ctx.stroke();

        if (bloomAlpha > 0.04) {
          const hGlow = ctx.createRadialGradient(86, 16, 2, 86, 16, 4 + 14 * bloomAlpha);
          hGlow.addColorStop(0.0, `rgba(255, 255, 255, ${(0.80 * bloomAlpha).toFixed(2)})`);
          hGlow.addColorStop(0.4, `rgba(160, 220, 255, ${(0.40 * bloomAlpha).toFixed(2)})`);
          hGlow.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
          ctx.fillStyle = hGlow;
          ctx.beginPath(); ctx.arc(86, 16, 4 + 14 * bloomAlpha, 0, Math.PI * 2); ctx.fill();
        }
      } else {
        ctx.fillStyle = '#263238';
        ctx.beginPath(); ctx.arc(86, 16, 4.2, -Math.PI * 0.5, Math.PI * 0.5);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#37474f'; ctx.lineWidth = 1.0; ctx.stroke();
      }
      ctx.restore();
      // ---------------------------------------------------------------------
      // 8. مصابيح الهيكل المدمجة (عدسات ميكانيكية واقعية بدون وهج شاذ في السطح)
      // ---------------------------------------------------------------------
      ctx.save();
      // أ. مصباح فحص مقدمة البرج المدمج (48, -53)
      ctx.fillStyle = '#1e272e';
      ctx.beginPath(); ctx.roundRect(46.5, -54.5, 4.5, 3.5, 1); ctx.fill();
      if (this.lightsOn) {
        ctx.fillStyle = '#fff9e6';
        ctx.beginPath(); ctx.arc(48.5, -52.8, 1.4, 0, Math.PI * 2); ctx.fill();
        if (bloomAlpha > 0.05) {
          const topGlow = ctx.createRadialGradient(48.5, -52.8, 0.8, 48.5, -52.8, 2 + 7 * bloomAlpha);
          topGlow.addColorStop(0.0, `rgba(255, 245, 200, ${(0.7 * bloomAlpha).toFixed(2)})`);
          topGlow.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
          ctx.fillStyle = topGlow;
          ctx.beginPath(); ctx.arc(48.5, -52.8, 2 + 7 * bloomAlpha, 0, Math.PI * 2); ctx.fill();
        }
      } else {
        ctx.fillStyle = '#3d4855';
        ctx.beginPath(); ctx.arc(48.5, -52.8, 1.3, 0, Math.PI * 2); ctx.fill();
      }

      // ب. مصباح مسح القاع السفلي الأمامي ببطن الغواصة (44, 28)
      ctx.fillStyle = '#1e272e';
      ctx.beginPath(); ctx.roundRect(41, 26, 6, 4.2, 1.2); ctx.fill();
      if (this.lightsOn) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(44, 28.2, 1.6, 0, Math.PI * 2); ctx.fill();
        if (bloomAlpha > 0.05) {
          const bGlow1 = ctx.createRadialGradient(44, 28.2, 1, 44, 32, 3 + 10 * bloomAlpha);
          bGlow1.addColorStop(0.0, `rgba(200, 235, 255, ${(0.75 * bloomAlpha).toFixed(2)})`);
          bGlow1.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
          ctx.fillStyle = bGlow1;
          ctx.beginPath(); ctx.arc(44, 30, 3 + 10 * bloomAlpha, 0, Math.PI * 2); ctx.fill();
        }
      } else {
        ctx.fillStyle = '#34495e';
        ctx.beginPath(); ctx.arc(44, 28.2, 1.5, 0, Math.PI * 2); ctx.fill();
      }

      // ج. مصباح مسح القاع السفلي الخلفي ببطن الغواصة (-8, 27)
      ctx.fillStyle = '#1e272e';
      ctx.beginPath(); ctx.roundRect(-11, 25, 6, 4.2, 1.2); ctx.fill();
      if (this.lightsOn) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(-8, 27.2, 1.6, 0, Math.PI * 2); ctx.fill();
        if (bloomAlpha > 0.05) {
          const bGlow2 = ctx.createRadialGradient(-8, 27.2, 1, -8, 31, 3 + 9 * bloomAlpha);
          bGlow2.addColorStop(0.0, `rgba(200, 235, 255, ${(0.70 * bloomAlpha).toFixed(2)})`);
          bGlow2.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
          ctx.fillStyle = bGlow2;
          ctx.beginPath(); ctx.arc(-8, 29, 3 + 9 * bloomAlpha, 0, Math.PI * 2); ctx.fill();
        }
      } else {
        ctx.fillStyle = '#34495e';
        ctx.beginPath(); ctx.arc(-8, 27.2, 1.5, 0, Math.PI * 2); ctx.fill();
      }

      // د. مؤشر الملاحة والضغط المدمج بجانب البرج (Status Indicator)
      ctx.fillStyle = '#05c46b';
      ctx.beginPath();
      ctx.ellipse(18, -40, 1.8, 1.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // ---------------------------------------------------------------------
      // 9. انعكاس الإضاءة السطحي الواقعي على معدن الغواصة (يتفاعل طردياً مع العمق)
      // ---------------------------------------------------------------------
      if (this.lightsOn) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';

        // لمعان ناعم ساقط على معدن القوس الأمامي المواجه لعدسة الكشاف
        const noseReflect = ctx.createLinearGradient(87, -7, 96, -2);
        noseReflect.addColorStop(0.0, 'rgba(255, 255, 255, 0)');
        noseReflect.addColorStop(0.7, `rgba(180, 235, 255, ${(0.25 * reflectAlpha).toFixed(2)})`);
        noseReflect.addColorStop(1.0, `rgba(255, 255, 255, ${(0.55 * reflectAlpha).toFixed(2)})`);
        ctx.fillStyle = noseReflect;
        ctx.beginPath();
        ctx.moveTo(88, -6);
        ctx.lineTo(96, -2);
        ctx.lineTo(89, 4);
        ctx.closePath();
        ctx.fill();

        // انعكاس بريق ناعم على حافة إطار القبة الزجاجية الأكريليكية المواجهة للضوء
        ctx.strokeStyle = `rgba(200, 240, 255, ${(0.22 * reflectAlpha).toFixed(2)})`;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.arc(74, 0, 16.5, -Math.PI * 0.12, Math.PI * 0.12);
        ctx.stroke();

        // انعكاس ناعم متدرج من مصباح البرج على سقف البرج
        const sailReflect = ctx.createLinearGradient(48, -53, 26, -53);
        sailReflect.addColorStop(0.0, `rgba(255, 245, 200, ${(0.30 * reflectAlpha).toFixed(2)})`);
        sailReflect.addColorStop(1.0, 'rgba(255, 245, 200, 0)');
        ctx.fillStyle = sailReflect;
        ctx.fillRect(26, -54, 22, 1.6);

        // لمعان خافت ساقط من مصابيح البطن على سطح زلاجات الهبوط
        const skidReflect = ctx.createLinearGradient(0, 28, 0, 36);
        skidReflect.addColorStop(0.0, `rgba(140, 210, 255, ${(0.22 * reflectAlpha).toFixed(2)})`);
        skidReflect.addColorStop(1.0, 'rgba(140, 210, 255, 0)');
        ctx.fillStyle = skidReflect;
        ctx.fillRect(-15, 28, 60, 6);

        ctx.restore();
      }
      // ---------------------------------------------------------------------
      // 10. ذراع الاستكشاف الروبوتية المدمجة (Articulated Sub-Arm)
      // ---------------------------------------------------------------------
      ctx.save();
      ctx.strokeStyle = '#57606f';
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(60, 18);
      ctx.lineTo(80, 22);
      ctx.lineTo(86, 16);
      ctx.stroke();

      // مفاصل وقابض العينات الاستكشافي الثلاثي
      ctx.fillStyle = '#2f3542';
      ctx.beginPath();
      ctx.arc(60, 18, 2.0, 0, Math.PI * 2);
      ctx.arc(80, 22, 2.0, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#747d8c';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(86, 16); ctx.lineTo(89, 13);
      ctx.moveTo(86, 16); ctx.lineTo(90, 17);
      ctx.stroke();
      ctx.restore();

      ctx.restore();

      // ---------------------------------------------------------------------
      // 11. فقاعات الدفع أو سحاب الدم المتصاعد
      // ---------------------------------------------------------------------
      if (this.bloodPlume && this.bloodPlume.length > 0) {
        ctx.save();
        for (const bp of this.bloodPlume) {
          if (bp.a <= 0.02) continue;
          ctx.fillStyle = `rgba(135, 15, 15, ${bp.a.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(bp.x - this.x, bp.y - this.y, bp.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      } else {
        ctx.fillStyle = 'rgba(215, 245, 255, 0.75)';
        this.bubbleTrail.forEachActive((b) => {
          ctx.beginPath();
          ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
          ctx.fill();
        });
      }
    }
  }
  class Camera2D {
    constructor() {
      this.x = 9520;
      this.y = 370;
      this.targetX = 9520;
      this.targetY = 370;
      this.zoom = 1.0;
      this.viewportWidth = 800;
      this.viewportHeight = 450;
      this.followEntity = null; // الكيان المتتبع تلقائيًا (الصياد أو الغواصة)
    }

    resize(vw, vh) {
      this.viewportWidth = vw;
      this.viewportHeight = vh;
      // ضبط الزوم ليتناسب تلقائيًا مع أحجام الشاشات المختلفة (iPad مقابل الهواتف الصغيرة)
      const baseH = 500;
      this.zoom = Math.max(0.65, Math.min(1.15, vh / baseH));
      this.clampTarget();
    }

    clampTarget() {
      const halfW = (this.viewportWidth * 0.5) / this.zoom;
      const halfH = (this.viewportHeight * 0.5) / this.zoom;

      this.targetX = Math.max(halfW, Math.min(WORLD.WIDTH - halfW, this.targetX));
      this.targetY = Math.max(halfH, Math.min(WORLD.HEIGHT - halfH, this.targetY));
    }

    update(dt) {
      // تتبع فوري وسلس للكيان النشط بدون ارتداد أو بطء
      if (this.followEntity) {
        const e = this.followEntity;
        this.targetX = e.x;
        this.targetY = e.y;
        this.clampTarget();
      }

      const factor = 1 - Math.exp(-22 * dt);
      this.x += (this.targetX - this.x) * factor;
      this.y += (this.targetY - this.y) * factor;
    }

    // تم استبداله: حذف دالة reset بعد إلغاء زر إعادة الضبط
  }
  // =========================================================================
  // 4. TERRAIN SYSTEM (طبيعي، غير هندسي، انتقال متدرج)
  // =========================================================================
  class TerrainSystem {
    constructor() {
      this.points = [];
      this.step = 16;
      this.rocks = [];
      this.generate();
    }

    generate() {
      this.points = [];
      const S = WORLD.SHORE_X, W = WORLD.WALL_X;
      const chasmC = W - 675; // مركز هوة الخندق عند قاعدة الجدار

      // 1. قاع خندق تشالنجر ديب (11,000م بالمقياس الموسع)
      for (let x = -100; x <= W - 120; x += 24) {
        const trenchChasm = (x > chasmC - 150 && x < chasmC + 150) ? 65 * Math.sin(((x - (chasmC - 150)) / 300) * Math.PI) : 0;
        const y = 66400 + trenchChasm + Math.sin(x * 0.02) * 22 + Math.cos(x * 0.05) * 12;
        this.points.push({ x, y, subType: 'hadovents' });
      }

      // 2. الجدار الصخري السحيق وصولاً إلى 11 كيلومتر
      for (let y = 66380; y >= 1000; y -= 32) {
        const t = (y - 1000) / 65400;
        const crag = Math.sin(y * 0.003) * 44 + Math.cos(y * 0.008) * 28 + Math.sin(y * 0.02) * 14;
        const x = W + crag - t * 45;
        this.points.push({ x, y, subType: 'deep_wall' });
      }

      // 3. المسطح 0→100م: ~6000 بكسل أفقياً (≈1000م أفقية مقابل 100م عمق) — رحلة غوص حقيقية
      for (let x = W; x <= S; x += 20) {
        const t = (S - x) / (S - W);
        const y = this.getHeightAt(x);
        const subType = (t < 0.05) ? 'sand' : (t < 0.3) ? 'soil' : 'rocky_soil';
        this.points.push({ x, y, subType });
      }

      // 4. الشاطئ والكثبان الرملية
      for (let x = S + 20; x <= WORLD.WIDTH + 100; x += 25) {
        const y = this.getHeightAt(x);
        this.points.push({ x, y, subType: 'dune' });
      }

      this.rocks = [];
      // منطقة الصخور الفعلية تنتهي عند 9350 بدقة لمنع أي تداخل مع مياه الرصيف
      this.rockBarrier = { startX: 8750, endX: 9350, topY: WORLD.WATER_Y + 10 };

      // 13 صخرة فريدة تماماً (Silhouettes مختلفة) لتشكيل تجمع صخري طبيعي
      const rockProfiles = [
        // صخور القاعدة العريضة
        { cx: 8810, pts: [[-70,0], [-50,-60], [-10,-90], [30,-80], [60,-40], [80,0]], shade: 0.85 },
        { cx: 8910, pts: [[-80,0], [-40,-110], [0,-140], [50,-120], [90,0]], shade: 0.9 },
        { cx: 9020, pts: [[-90,0], [-50,-160], [10,-190], [60,-150], [100,0]], shade: 0.8 },
        { cx: 9130, pts: [[-85,0], [-30,-130], [20,-150], [60,-100], [90,0]], shade: 0.95 },
        { cx: 9230, pts: [[-60,0], [-20,-80], [30,-90], [70,0]], shade: 0.88 },
        // صخور الطبقة المتوسطة المتداخلة
        { cx: 8860, pts: [[-50,0], [-20,-130], [10,-150], [40,-110], [60,0]], shade: 1.1 },
        { cx: 8960, pts: [[-60,0], [-30,-180], [15,-210], [45,-160], [65,0]], shade: 1.05 },
        { cx: 9070, pts: [[-70,0], [-25,-170], [25,-190], [55,-140], [75,0]], shade: 1.15 },
        { cx: 9180, pts: [[-55,0], [-15,-120], [25,-140], [50,-90], [65,0]], shade: 1.0 },
        // صخور حادة لكسر النمط
        { cx: 8930, pts: [[-40,0], [-10,-200], [20,-190], [45,0]], shade: 1.2 },
        { cx: 9040, pts: [[-45,0], [0,-230], [35,-180], [50,0]], shade: 1.25 },
        // صخور صغيرة للأطراف
        { cx: 8780, pts: [[-30,0], [-10,-40], [15,-45], [35,0]], shade: 1.1 },
        { cx: 9300, pts: [[-35,0], [-5,-50], [20,-40], [40,0]], shade: 1.05 }
      ];

      for (let i = 0; i < rockProfiles.length; i++) {
        const p = rockProfiles[i];
        const groundY = this.getHeightAt(p.cx) + 15; // غرس الصخرة في القاع
        const maxAllowedHeight = groundY - (WORLD.WATER_Y + 12); // ضمان البقاء تحت الماء بـ 12 بكسل

        let designMaxH = 0;
        for (const pt of p.pts) {
          if (-pt[1] > designMaxH) designMaxH = -pt[1];
        }

        // ضغط الصخرة عمودياً فقط إذا كانت ستتجاوز سطح الماء
        const scaleY = designMaxH > maxAllowedHeight ? (maxAllowedHeight / designMaxH) : 1.0;

        // عمق دفن إضافي متفاوت لضمان انغراس القاعدة بالكامل داخل تضاريس القاع
        const buryDepth = 15 + (i % 4) * 12 + (p.cx % 3) * 8;

        const vertices = p.pts.map(pt => {
          if (pt[1] === 0) return { x: pt[0], y: buryDepth };
          return { x: pt[0], y: pt[1] * scaleY };
        });
        // حدود AABB أفقية لكل صخرة لتسريع الفحص وتجاوز الصخور البعيدة فورياً
        let minX = Infinity, maxX = -Infinity;
        for (const pt of vertices) {
          if (p.cx + pt.x < minX) minX = p.cx + pt.x;
          if (p.cx + pt.x > maxX) maxX = p.cx + pt.x;
        }
        this.rocks.push({ x: p.cx, y: groundY, vertices, shade: p.shade, minX, maxX });
      }

      // جدول بحث سطح الصخور (Lookup كل 4px) — يستبدل فحص 13 مضلعاً لكل استعلام
      this.buildRockSurfaceTable();
      this.buildCrackPaths();
    }

    getHeightAt(x) {
      const S = WORLD.SHORE_X, W = WORLD.WALL_X;
      if (x >= S) {
        const rampT = Math.min(1, (x - S) / 70);
        const t = (x - S) / 800;
        const duneH = 115 * Math.pow(t, 0.8) - Math.sin(x * 0.018) * 7;
        const dockY = WORLD.WATER_Y - 26;
        const rampY = WORLD.WATER_Y - (WORLD.WATER_Y - dockY) * rampT;
        return Math.min(rampY, WORLD.WATER_Y - duneH);
      }
      if (x >= W) {
        // نفس منحنى القديم لكن ممدود أفقياً 4.5×: العمق 100م عند W والسطح عند S
        const t = (S - x) / (S - W);
        return WORLD.WATER_Y + 600 * Math.pow(t, 1.15) + Math.sin(x * 0.015) * 8;
      }
      const chasmC = W - 675;
      const trenchChasm = (x > chasmC - 150 && x < chasmC + 150) ? 65 * Math.sin(((x - (chasmC - 150)) / 300) * Math.PI) : 0;
      return 66400 + trenchChasm + Math.sin(x * 0.02) * 22 + Math.cos(x * 0.05) * 12;
    }

    // جدول بحث ثابت لسطح الصخور: O(1) بدل فحص كل المضلعات (تصادم + كشاف)
    buildRockSurfaceTable() {
      const b = this.rockBarrier;
      this._rsX0 = b.startX - 40;
      this._rsStep = 4;
      const n = Math.ceil((b.endX + 40 - this._rsX0) / this._rsStep) + 1;
      this._rsTable = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const val = this._computeRockSurfaceAt(this._rsX0 + i * this._rsStep);
        this._rsTable[i] = val !== null ? val : -1;
      }
    }

    getRockSurfaceAt(x) {
      if (!this.rockBarrier || x < this.rockBarrier.startX || x > this.rockBarrier.endX) return null;
      if (!this._rsTable) return this._computeRockSurfaceAt(x);
      const f = (x - this._rsX0) / this._rsStep;
      const i = Math.max(0, Math.min(this._rsTable.length - 2, Math.floor(f)));
      const v1 = this._rsTable[i], v2 = this._rsTable[i + 1];
      if (v1 <= 0 || v2 <= 0) return null;
      const t = Math.max(0, Math.min(1, f - i));
      return v1 + (v2 - v1) * t;
    }

    _computeRockSurfaceAt(x) {
      if (!this.rocks || this.rocks.length === 0) return null;

      let highestY = Infinity;
      for (const rock of this.rocks) {
        // تخطي الصخرة فورياً إذا كان الإحداثي خارج نطاقها الأفقي O(1)
        if (x < rock.minX || x > rock.maxX) continue;
        for (let i = 0; i < rock.vertices.length - 1; i++) {
          const x1 = rock.x + rock.vertices[i].x;
          const y1 = rock.y + rock.vertices[i].y;
          const x2 = rock.x + rock.vertices[i+1].x;
          const y2 = rock.y + rock.vertices[i+1].y;

          const minX = Math.min(x1, x2);
          const maxX = Math.max(x1, x2);

          if (x >= minX && x <= maxX && minX !== maxX) {
            const t = (x - minX) / (maxX - minX);
            const startY = (minX === x1) ? y1 : y2;
            const endY = (minX === x1) ? y2 : y1;
            const y = startY + t * (endY - startY);
            if (y < highestY) highestY = y;
          }
        }
      }
      return highestY !== Infinity ? highestY : null;
    }

    // بناء الشقوق البازلتية وعروق الماغما مرة واحدة كمسارات ثابتة — يقتل حسابات الجيوب والمسارات كل إطار
    buildCrackPaths() {
      const pts = this.points;
      const basalt = new Path2D();
      const magma = new Path2D();
      for (let i = 8; i < pts.length - 8; i += 7) {
        const p = pts[i];
        const seed = Math.sin(p.y * 0.13 + p.x * 0.07) * 10000;
        const rnd = seed - Math.floor(seed);
        if (rnd > 0.42) continue;
        const len1 = 30 + rnd * 50;
        const len2 = 25 + (1 - rnd) * 45;
        const dy1 = (rnd - 0.5) * 35;
        const dy2 = (0.5 - rnd) * 30;
        const depthOffset = 40 + rnd * 60;
        if (p.y > 30400 && p.y <= 45400) {
          basalt.moveTo(p.x + depthOffset, p.y);
          basalt.lineTo(p.x + depthOffset + len1, p.y + dy1);
          if (rnd < 0.25) basalt.lineTo(p.x + depthOffset + len1 + len2, p.y + dy1 + dy2);
        } else if (p.y > 45400) {
          magma.moveTo(p.x + depthOffset, p.y + 16);
          magma.lineTo(p.x + depthOffset + len1, p.y + dy1 + 22);
        }
      }
      this.crackPaths = { basalt, magma };
    }

    getWallX(y) {
      if (y < 1000) return WORLD.WALL_X;
      const t = Math.max(0, Math.min(1, (y - 1000) / 65400));
      const crag = Math.sin(y * 0.003) * 44 + Math.cos(y * 0.008) * 28 + Math.sin(y * 0.02) * 14;
      return WORLD.WALL_X + crag - t * 45;
    }
  }

  // =========================================================================
  // 5. BENTHIC ECOLOGY SYSTEM (توزيع بيولوجي دقيق)
  // =========================================================================
  class EcologySystem {
    constructor(terrain) {
      this.terrain = terrain;
      this.organisms = [];
      this.generateBenthos();
    }

    generateBenthos() {
      const rng = new DeterministicRNG(789123);
      this.organisms = [];

      // قراءة العمق الفعلي مباشرة من التضاريس الحالية — لا إحداثيات ثابتة
      const depthAt = (x) => (this.terrain.getHeightAt(x) - WORLD.WATER_Y) / WORLD.PIXELS_PER_METER;
      const barrier = this.terrain.rockBarrier;
      const nearRocks = (x) => barrier && x >= barrier.startX - 40 && x <= barrier.endX + 40;

      const addGrass = (x) => this.organisms.push({
        type: 'seagrass', x,
        bladeCount: Math.floor(rng.range(3, 7)),
        height: rng.range(22, 42),
        phase: rng.range(0, Math.PI * 2),
        speed: rng.range(1.1, 1.6),
        hue: rng.range(88, 112)
      });
      const addAlgae = (x, type, hue0, hue1, hMin, hMax) => this.organisms.push({
        type, x, y: this.terrain.getHeightAt(x),
        height: rng.range(hMin, hMax),
        phase: rng.range(0, Math.PI * 2),
        speed: rng.range(0.7, 1.3),
        branchCount: Math.floor(rng.range(2, 5)),
        hue: rng.range(hue0, hue1)
      });

      // المسح كاملاً مع ترك مدخل الرصيف والشاطئ سالكاً وخالياً من العوائق
      for (let x = WORLD.WALL_X + 60; x < WORLD.SHORE_X - 220; x += rng.range(14, 26)) {
        const d = depthAt(x);
        if (d <= 1.2 || d > 100) continue;
        const r = rng.next();

        if (d <= 20) {
          // 0–20م: حياة فوق/حول الصخور فقط (أو رمل ضحل أعلى 5م)
          if (d > 5 && !nearRocks(x)) continue;
          if (d > 1.2 && r < 0.45) addGrass(x);
          else if (r < 0.8) addAlgae(x, 'shallow_green_algae', 98, 126, 20, 45);
          else addAlgae(x, 'brown_macroalgae', 30, 46, 18, 40);
        } else if (d <= 25) {
          // 20–25م: انتقالي — بنية وحمراء + أعشاب قليلة
          if (r < 0.15) addGrass(x);
          else if (r < 0.6) addAlgae(x, 'brown_macroalgae', 28, 44, 28, 55);
          else addAlgae(x, 'red_algae', 344, 356, 16, 34);
        } else if (d <= 50) {
          // 25–50م: طحالب بنية كبيرة + بعض الأعشاب + حمراء
          if (r < 0.18) addGrass(x);
          else if (r < 0.62) addAlgae(x, 'brown_macroalgae', 26, 42, 34, 60);
          else addAlgae(x, 'red_algae', 342, 356, 18, 38);
        } else if (d <= 90) {
          // 50–90م: حمراء وقشرية؛ الأعشاب نادرة
          if (r < 0.05) addGrass(x);
          else if (r < 0.55) addAlgae(x, 'red_algae', 340, 356, 14, 30);
          else if (r < 0.92) addAlgae(x, 'crustose_algae', 335, 352, 5, 11);
        } else {
          // 90–100م: نادرة جداً — حمراء/قشرية فقط
          if (r < 0.18) addAlgae(x, r < 0.09 ? 'red_algae' : 'crustose_algae', 338, 356, 8, 20);
        }
      }
    }
  }

  // =========================================================================
  // 5.5 FAUNA CONFIG & SPECIES ARCHETYPES (1–111m)
  // =========================================================================
  const FAUNA_DEFS = {
    crab: { min: 1, opt: 5, max: 12, kind: 'crawl', spd: 14, scale: 1.0 },
    urchin: { min: 1, opt: 6, max: 14, kind: 'sessile', spd: 0, scale: 0.9 },
    small_fish: { min: 1, opt: 7, max: 16, kind: 'swim', spd: 46, scale: 0.8 },
    salema: { min: 8, opt: 15, max: 24, kind: 'swim', spd: 42, scale: 1.1 },
    bream: { min: 9, opt: 16, max: 25, kind: 'swim', spd: 44, scale: 1.15 },
    octopus: { min: 10, opt: 45, max: 84, kind: 'octo', spd: 22, scale: 1.2 },
    wrasse: { min: 18, opt: 25, max: 34, kind: 'swim', spd: 40, scale: 1.0 },
    squid: { min: 18, opt: 26, max: 35, kind: 'squid', spd: 50, scale: 1.1 },
    shrimp: { min: 19, opt: 27, max: 36, kind: 'shrimp', spd: 28, scale: 0.7 },
    bogue: { min: 28, opt: 46, max: 64, kind: 'swim', spd: 46, scale: 1.0 },
    dentex: { min: 28, opt: 48, max: 65, kind: 'pred', spd: 58, scale: 1.35 },
    seabass: { min: 38, opt: 55, max: 74, kind: 'pred', spd: 56, scale: 1.4 },
    scorpionfish: { min: 38, opt: 56, max: 74, kind: 'ambush', spd: 8, scale: 1.2 },
    lobster: { min: 38, opt: 58, max: 75, kind: 'crawl', spd: 12, scale: 1.25 },
    sardine: { min: 66, opt: 75, max: 84, kind: 'swim', spd: 52, scale: 0.9 },
    dogfish: { min: 68, opt: 86, max: 104, kind: 'pred', spd: 44, scale: 1.6 },
    conger: { min: 78, opt: 95, max: 111, kind: 'eel', spd: 26, scale: 1.5 },
    spider_crab: { min: 78, opt: 86, max: 95, kind: 'crawl', spd: 10, scale: 1.3 },
    red_coral: { min: 88, opt: 102, max: 111, kind: 'sessile', spd: 0, scale: 1.2 },
    rare_octopus: { min: 98, opt: 106, max: 111, kind: 'octo', spd: 20, scale: 1.4 },
    // كائنات الأعماق المتوسطة (111–1000م)
    blue_whale: { min: 111, opt: 200, max: 320, kind: 'whale', spd: 32, scale: 4.2, rarity: 0.08 },
    sperm_whale: { min: 140, opt: 260, max: 450, kind: 'whale', spd: 30, scale: 3.5, rarity: 0.10 },
    gulper_shark: { min: 120, opt: 240, max: 550, kind: 'pred', spd: 36, scale: 1.4, rarity: 0.35 },
    grouper: { min: 111, opt: 220, max: 350, kind: 'ambush', spd: 22, scale: 1.5, rarity: 0.45 },
    hatchetfish: { min: 280, opt: 480, max: 700, kind: 'swim', spd: 22, scale: 0.75, rarity: 0.65 },
    lanternfish: { min: 290, opt: 560, max: 1050, kind: 'biolum_small', spd: 32, scale: 0.7, rarity: 0.6, biolum: true },
    dragonfish: { min: 380, opt: 750, max: 1550, kind: 'biolum_pred', spd: 30, scale: 1.25, rarity: 0.35, biolum: true },
    viperfish: { min: 550, opt: 850, max: 1250, kind: 'biolum_pred', spd: 34, scale: 1.15, rarity: 0.35, biolum: true },
    deep_eel: { min: 600, opt: 950, max: 1500, kind: 'eel', spd: 24, scale: 1.4, rarity: 0.4 },
    deep_squid: { min: 200, opt: 900, max: 2500, kind: 'squid', spd: 38, scale: 1.35, rarity: 0.45 },
    // كائنات الأعماق السحيقة (1000–5000م)
    anglerfish: { min: 950, opt: 1300, max: 2100, kind: 'biolum_pred', spd: 18, scale: 1.3, rarity: 0.28, biolum: true },
    swallower: { min: 950, opt: 1350, max: 1850, kind: 'pred', spd: 26, scale: 1.1, rarity: 0.35 },
    dumbo_octo: { min: 1400, opt: 2200, max: 5000, kind: 'dumbo', spd: 15, scale: 1.15, rarity: 0.22 },
    giant_isopod: { min: 1400, opt: 2800, max: 5000, kind: 'crawl', spd: 8, scale: 1.4, rarity: 0.3 },
    deep_jelly: { min: 1300, opt: 2400, max: 5000, kind: 'jelly', spd: 12, scale: 1.25, rarity: 0.35, biolum: true },
    tripod_fish: { min: 2200, opt: 3100, max: 4200, kind: 'tripod', spd: 5, scale: 1.25, rarity: 0.25 },
    deep_shrimp: { min: 2200, opt: 2900, max: 3700, kind: 'shrimp', spd: 24, scale: 0.8, rarity: 0.4 },
    sea_pig: { min: 2400, opt: 3600, max: 5000, kind: 'crawl', spd: 6, scale: 1.0, rarity: 0.22 },
    amphipod: { min: 3200, opt: 4200, max: 5000, kind: 'swim', spd: 16, scale: 0.75, rarity: 0.25 },
    // كائنات الأعماق الخيالية الأسطورية (9500–11000م)
    trench_guardian: { min: 9500, opt: 9800, max: 10100, kind: 'guardian', spd: 4, scale: 3.2, rarity: 0.25, biolum: true },
    dark_flutter: { min: 9500, opt: 9800, max: 10100, kind: 'flutter', spd: 18, scale: 1.6, rarity: 0.35, biolum: true },
    glass_serpent: { min: 10000, opt: 10250, max: 10600, kind: 'glass_serp', spd: 28, scale: 2.6, rarity: 0.3, biolum: true },
    roaming_coral: { min: 10000, opt: 10300, max: 10600, kind: 'coral_beast', spd: 3, scale: 2.0, rarity: 0.35 },
    black_spider: { min: 10500, opt: 10750, max: 11000, kind: 'spider', spd: 26, scale: 1.8, rarity: 0.38 }
  };

  function getSpeciesWeight(def, depthM) {
    if (depthM < def.min || depthM > def.max) return 0;
    const spread = (def.max - def.min) * 0.5;
    const dist = Math.abs(depthM - def.opt) / spread;
    return Math.max(0, 1 - dist * dist);
  }

  class MarineCreature {
    constructor() {
      this.active = false;
      this.type = 'small_fish';
      this.kind = 'swim';
      this.x = 0; this.y = 0;
      this.vx = 0; this.vy = 0;
      this.angle = 0;
      this.scale = 1;
      this.animTime = 0;
      this.baseSpeed = 40;
      this.fleeTimer = 0;
      this.chasing = null;
      this.chaseTimer = 0;
      this.huntCooldown = 15;
      this.swimPhase = Math.random() * Math.PI * 2;
      this.biolum = false;
    }

    reset(type, x, y, dir) {
      const def = FAUNA_DEFS[type];
      this.active = true;
      this.type = type;
      this.kind = def.kind;
      this.scale = def.scale * (0.9 + Math.random() * 0.2);
      this.baseSpeed = def.spd;
      this.biolum = !!def.biolum;
      this.x = x; this.y = y;
      this.vx = (dir || (Math.random() < 0.5 ? 1 : -1)) * def.spd;
      this.vy = (Math.random() - 0.5) * (def.spd * 0.3);
      this.angle = Math.atan2(this.vy, this.vx);
      this.animTime = Math.random() * 10;
      this.fleeTimer = 0;
      this.chasing = null;
      this.chaseTimer = 0;
      this.huntCooldown = 12 + Math.random() * 15;
    }

    update(dt, terrain, sub, diver) {
      if (!this.active) return;
      this.animTime += dt;
      if (this.huntCooldown > 0) this.huntCooldown -= dt;
      if (this.fleeTimer > 0) this.fleeTimer -= dt;

      const gy = terrain.getHeightAt(this.x);
      const ry = terrain.getRockSurfaceAt ? terrain.getRockSurfaceAt(this.x) : null;
      const surfY = ry !== null ? Math.min(gy, ry) : gy;

      if (this.kind === 'sessile') {
        this.y = surfY - 3;
        return;
      }

      // كائنات الجدار السحيق وخندق تشالنجر ديب (العناكب والكائنات القاعية)
      if (this.y >= 1000 && (this.kind === 'crawl' || this.kind === 'tripod' || this.kind === 'spider' || this.kind === 'guardian' || this.kind === 'coral_beast')) {
        const gy = terrain.getHeightAt(this.x);
        const wx = terrain.getWallX(this.y);
        if (this.y >= 60000 && this.kind !== 'spider') {
          this.y = gy - 4; this.x += this.vx * dt * 0.3;
        } else {
          this.x = wx - 6; this.y += this.vy * dt * 0.5;
        }
        if (Math.random() < 0.01) this.vy = -this.vy;
        return;
      }

      if (this.kind === 'crawl' || this.kind === 'ambush') {
        this.y = surfY - 3;
        if (this.kind === 'crawl') {
          this.x += this.vx * dt;
          if (this.x > WORLD.SHORE_X - 90) { this.x = WORLD.SHORE_X - 90; this.vx = -Math.abs(this.vx); }
          if (this.x < WORLD.WALL_X + 15) { this.x = WORLD.WALL_X + 15; this.vx = Math.abs(this.vx); }
          if (Math.random() < 0.015) this.vx = -this.vx;
        }
        return;
      }

      if (this.kind === 'jelly') {
        // حركة نبض هادئة لقناديل الأعماق
        const pulse = Math.sin(this.animTime * 1.8);
        this.y -= (pulse > 0 ? pulse * 14 : pulse * 4) * dt;
        this.x += this.vx * dt * 0.3;
        return;
      }

      this.updateSwimming(dt, terrain, sub, diver);
    }

    updateSwimming(dt, terrain, sub, diver) {
      // تفادي هيكل الغواصة والغواص
      const rep = sub && sub.occupied ? sub : diver;
      if (rep) {
        const d = Math.hypot(this.x - rep.x, this.y - rep.y);
        if (d < 85) {
          const a = Math.atan2(this.y - rep.y, this.x - rep.x);
          this.vx += Math.cos(a) * 110 * dt;
          this.vy += Math.sin(a) * 110 * dt;
          this.fleeTimer = 1.4;
        }
      }

      // توجيه انسيابي وضبط الاتجاه
      const speed = Math.hypot(this.vx, this.vy);
      const targetSpd = this.fleeTimer > 0 ? this.baseSpeed * 1.8 : this.baseSpeed;
      if (speed > 1) {
        this.vx = (this.vx / speed) * (speed + (targetSpd - speed) * dt * 3);
        this.vy = (this.vy / speed) * (speed + (targetSpd - speed) * dt * 3);
        const targetAng = Math.atan2(this.vy, this.vx);
        const diff = Math.atan2(Math.sin(targetAng - this.angle), Math.cos(targetAng - this.angle));
        this.angle += diff * Math.min(1, dt * 5);
      }

      this.x += this.vx * dt;
      this.y += this.vy * dt;

      // حظر الدخول إلى اليابسة في اليمين أو الجدار الصخري
      if (this.x > WORLD.SHORE_X - 90) {
        this.x = WORLD.SHORE_X - 90;
        this.vx = -Math.abs(this.vx);
      }
      if (this.y >= 1000) {
        const wx = terrain.getWallX(this.y);
        if (this.x > wx - 16) {
          this.x = wx - 16;
          this.vx = -Math.abs(this.vx);
        }
      }

      // حدود عمود الماء وقاع البحر
      const topLimit = WORLD.WATER_Y + 8;
      const gy = terrain.getHeightAt(this.x);
      const ry = terrain.getRockSurfaceAt ? terrain.getRockSurfaceAt(this.x) : null;
      const botLimit = (ry !== null ? Math.min(gy, ry) : gy) - 12;
      if (this.y < topLimit) { this.y = topLimit; this.vy = Math.abs(this.vy); }
      if (this.y > botLimit) { this.y = botLimit; this.vy = -Math.abs(this.vy) * 0.8; }
    }

    draw(ctx) {
      if (!this.active) return;
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(this.angle);
      if (Math.cos(this.angle) < 0) ctx.scale(1, -1);
      ctx.scale(this.scale, this.scale);

      if (this.kind === 'whale') {
        this.drawWhale(ctx);
      } else if (this.kind === 'guardian' || this.kind === 'flutter' || this.kind === 'glass_serp' || this.kind === 'coral_beast' || this.kind === 'spider') {
        this.drawMythicCreature(ctx);
      } else if (this.kind === 'jelly') {
        this.drawDeepJelly(ctx);
      } else if (this.kind === 'dumbo' || this.kind === 'tripod') {
        this.drawDumboAndTripod(ctx);
      } else if (this.kind === 'biolum_pred') {
        this.drawDeepPredator(ctx);
      } else if (this.kind === 'biolum_small') {
        this.drawLanternOrHatchet(ctx);
      } else if (this.kind === 'swim' || this.kind === 'pred') {
        this.drawFish(ctx);
      } else if (this.kind === 'octo') {
        this.drawOctopus(ctx);
      } else if (this.kind === 'crawl' || this.kind === 'ambush') {
        this.drawBenthic(ctx);
      } else if (this.kind === 'squid' || this.kind === 'shrimp') {
        this.drawInvertebrate(ctx);
      } else {
        this.drawSessileOrEel(ctx);
      }
      ctx.restore();
    }

    drawMythicCreature(ctx) {
      if (this.kind === 'guardian') {
        // حارس الخندق السحيق: دروع داكنة، رأس ضخم، وعيون متوهجة
        ctx.fillStyle = '#0d1318';
        ctx.beginPath(); ctx.roundRect(-25, -12, 50, 24, 6); ctx.fill();
        ctx.fillStyle = '#182129';
        for (let i = -18; i <= 18; i += 9) {
          ctx.beginPath(); ctx.ellipse(i, -6, 5, 8, 0.2, 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = 'rgba(80, 240, 255, 0.95)';
        ctx.beginPath(); ctx.arc(18, -4, 2, 0, Math.PI * 2); ctx.arc(18, 4, 2, 0, Math.PI * 2); ctx.fill();
      } else if (this.kind === 'flutter') {
        // فراشة الظلام: أجنحة غشائية واسعة ومضيئة بخفوت
        const flp = Math.sin(this.animTime * 2.2) * 5;
        ctx.fillStyle = 'rgba(70, 35, 110, 0.75)';
        ctx.beginPath();
        ctx.moveTo(12, 0); ctx.quadraticCurveTo(0, -22 + flp, -18, -14);
        ctx.lineTo(-6, 0); ctx.lineTo(-18, 14); ctx.quadraticCurveTo(0, 22 - flp, 12, 0);
        ctx.fill();
        ctx.strokeStyle = 'rgba(120, 190, 255, 0.6)'; ctx.lineWidth = 1; ctx.stroke();
      } else {
        this.drawDeepMythicPart2(ctx);
      }
    }

    drawWhale(ctx) {
      if (this.type === 'blue_whale') {
        this.drawBlueWhale(ctx);
      } else {
        this.drawSpermWhale(ctx);
      }
    }

    drawBlueWhale(ctx) {
      const flk = Math.sin(this.animTime * 1.4) * 5;
      // 1. هيكل الحوت الأزرق الانسيابي الممشوق
      ctx.fillStyle = '#2d475c';
      ctx.beginPath();
      ctx.moveTo(46, 0); // خطم الرأس العريض
      ctx.bezierCurveTo(34, -7.5, 8, -8.5, -24, -5.5); // ظهر الحوت
      ctx.lineTo(-28, -8.5); ctx.lineTo(-30, -5); // زعنفة ظهرية صغيرة متأخرة
      ctx.quadraticCurveTo(-40, -4, -48, -1.5); // السويقة الذيلية
      ctx.lineTo(-58, -14 + flk); // فص الذيل العلوي
      ctx.quadraticCurveTo(-52, flk, -58, 14 + flk); // ثلمة الذيل الوسطية والفص السفلي
      ctx.lineTo(-48, 1.5);
      ctx.quadraticCurveTo(-38, 5, -20, 8); // البطن
      ctx.bezierCurveTo(8, 10.5, 36, 6.5, 46, 0); // الفك السفلي
      ctx.closePath(); ctx.fill();

      // 2. بطن فاتح وتجاويف الحنجرة (Throat Grooves)
      ctx.fillStyle = '#55768c';
      ctx.beginPath();
      ctx.moveTo(42, 1);
      ctx.bezierCurveTo(24, 6.5, -8, 6.5, -20, 4);
      ctx.lineTo(-18, 1.5);
      ctx.bezierCurveTo(-6, 2, 22, 2, 42, 1);
      ctx.fill();
      ctx.strokeStyle = 'rgba(25, 45, 60, 0.4)'; ctx.lineWidth = 0.8;
      for (let yo = 2.5; yo <= 5.5; yo += 1.5) {
        ctx.beginPath(); ctx.moveTo(35, yo); ctx.lineTo(-12, yo + 0.4); ctx.stroke();
      }

      // 3. الزعنفة الصدرية الرشيقة والعين الهادئة
      ctx.fillStyle = '#22384a';
      ctx.beginPath();
      ctx.moveTo(10, 3); ctx.lineTo(-4, 15); ctx.lineTo(-1, 16); ctx.lineTo(13, 5);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#0f1820';
      ctx.beginPath(); ctx.arc(32, -1.5, 1.2, 0, Math.PI * 2); ctx.fill();
    }

    drawSpermWhale(ctx) {
      const flk = Math.sin(this.animTime * 1.3) * 4.5;
      ctx.fillStyle = '#22272c';
      ctx.beginPath();
      ctx.moveTo(38, -9); ctx.lineTo(38, 6); ctx.lineTo(26, 6);
      ctx.lineTo(24, 8); ctx.lineTo(6, 8);
      ctx.quadraticCurveTo(-20, 7, -42, 2);
      ctx.lineTo(-54, -13 + flk); ctx.lineTo(-48, flk); ctx.lineTo(-54, 13 + flk);
      ctx.lineTo(-42, -2); ctx.lineTo(-24, -6);
      ctx.lineTo(-20, -8); ctx.lineTo(-16, -6);
      ctx.lineTo(32, -9); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#171b1f';
      ctx.beginPath(); ctx.ellipse(8, 4, 7, 3.5, 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0b0e11';
      ctx.beginPath(); ctx.arc(22, 2, 1.1, 0, Math.PI * 2); ctx.fill();
    }

    drawDeepJelly(ctx) {
      const p = Math.sin(this.animTime * 1.8) * 2;
      ctx.fillStyle = 'rgba(150, 20, 35, 0.82)';
      ctx.beginPath();
      ctx.arc(0, -3 + p * 0.5, 8, Math.PI, Math.PI * 2);
      ctx.fill();
      // نقاط الإضاءة الحيوية الفيروزية على حافة القنديل
      ctx.fillStyle = 'rgba(80, 230, 255, 0.9)';
      for (let i = -6; i <= 6; i += 3) {
        ctx.beginPath(); ctx.arc(i, -2.5, 0.8, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(180, 40, 50, 0.6)'; ctx.lineWidth = 1.0;
      for (let i = -4; i <= 4; i += 2) {
        ctx.beginPath(); ctx.moveTo(i, -2); ctx.lineTo(i * 1.2, 12 - p); ctx.stroke();
      }
    }

    drawFish(ctx) {
      const tailOsc = Math.sin(this.animTime * 11) * 3;
      let bodyCol = '#7da2b8', bellyCol = '#dcebf2';
      if (this.type === 'salema') { bodyCol = '#c2a84a'; bellyCol = '#e8dec0'; }
      else if (this.type === 'bream') { bodyCol = '#9cb4c2'; bellyCol = '#edf5fa'; }
      else if (this.type === 'wrasse') { bodyCol = '#3ea876'; bellyCol = '#f2a654'; }
      else if (this.type === 'dentex') { bodyCol = '#56809e'; bellyCol = '#cfdbe3'; }
      else if (this.type === 'seabass') { bodyCol = '#476273'; bellyCol = '#b5c8d4'; }
      else if (this.type === 'dogfish') { bodyCol = '#525a61'; bellyCol = '#8e989e'; }

      ctx.fillStyle = bodyCol;
      ctx.beginPath();
      ctx.moveTo(11, 0);
      ctx.quadraticCurveTo(0, -5, -9, 0);
      ctx.quadraticCurveTo(0, 5, 11, 0);
      ctx.fill();

      // ذيل خفاق وزعنفة خلفية
      ctx.fillStyle = bellyCol;
      ctx.beginPath();
      ctx.moveTo(-9, 0);
      ctx.lineTo(-15, -4 + tailOsc);
      ctx.lineTo(-13, 0);
      ctx.lineTo(-15, 4 + tailOsc);
      ctx.closePath();
      ctx.fill();

      // عين الكائن
      ctx.fillStyle = '#08121a';
      ctx.beginPath();
      ctx.arc(7, -1.2, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }

    drawDeepPredator(ctx) {
      const isAngler = this.type === 'anglerfish';
      ctx.fillStyle = isAngler ? '#141416' : '#1a1d20';
      ctx.beginPath();
      ctx.ellipse(0, 0, isAngler ? 11 : 16, isAngler ? 9 : 5, 0, 0, Math.PI * 2);
      ctx.fill();
      // أسنان إبرية شفافة
      ctx.strokeStyle = 'rgba(230, 240, 255, 0.7)'; ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(8, -3); ctx.lineTo(12, 0); ctx.lineTo(8, 3); ctx.stroke();

      if (isAngler) {
        // قصبة الصيد وطُعم الإضاءة الحيوية المتوهج
        ctx.strokeStyle = '#3a444a'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(4, -8); ctx.quadraticCurveTo(8, -15, 14, -13); ctx.stroke();
        ctx.fillStyle = 'rgba(100, 255, 230, 0.95)';
        ctx.beginPath(); ctx.arc(14, -13, 2, 0, Math.PI * 2); ctx.fill();
      }
    }

    drawLanternOrHatchet(ctx) {
      ctx.fillStyle = this.type === 'hatchetfish' ? '#b0c2cc' : '#2b3842';
      ctx.beginPath(); ctx.ellipse(0, 0, 8, 5, 0, 0, Math.PI * 2); ctx.fill();
      // نقاط مضيئة على بطن سمكة الفانوس
      ctx.fillStyle = 'rgba(120, 220, 255, 0.85)';
      for (let i = -5; i <= 5; i += 2.5) {
        ctx.beginPath(); ctx.arc(i, 3.5, 0.7, 0, Math.PI * 2); ctx.fill();
      }
    }

    drawOctopus(ctx) {
      const tent = Math.sin(this.animTime * 4) * 2;
      ctx.fillStyle = this.type === 'rare_octopus' ? '#702244' : '#9c4e31';
      ctx.beginPath();
      ctx.ellipse(3, 0, 7, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = 1.6;
      for (let i = -3; i <= 3; i += 2) {
        ctx.beginPath();
        ctx.moveTo(-3, i);
        ctx.quadraticCurveTo(-9, i + tent, -14, i * 1.5 - tent);
        ctx.stroke();
      }
      ctx.fillStyle = '#fce49f';
      ctx.beginPath(); ctx.arc(4, -2, 1.2, 0, Math.PI * 2); ctx.fill();
    }

    drawDeepMythicPart2(ctx) {
      if (this.kind === 'glass_serp') {
        // الأفعى الزجاجية: جسم نحيل شبه شفاف مع خط ضوئي داخلي
        const sWave = Math.sin(this.animTime * 3) * 4;
        ctx.strokeStyle = 'rgba(160, 220, 245, 0.45)'; ctx.lineWidth = 5; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(22, 0); ctx.quadraticCurveTo(5, sWave, -22, -sWave); ctx.stroke();
        ctx.strokeStyle = 'rgba(100, 255, 240, 0.9)'; ctx.lineWidth = 1.6; ctx.stroke();
      } else if (this.kind === 'coral_beast') {
        // المرجان المتجوّل: كروي مغطى بنتوءات وزوائد مرجانية
        ctx.fillStyle = '#22141a'; ctx.beginPath(); ctx.arc(0, 0, 14, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#6b2432';
        for (let a = 0; a < Math.PI * 2; a += 0.9) {
          ctx.beginPath(); ctx.arc(Math.cos(a) * 12, Math.sin(a) * 12, 3.5, 0, Math.PI * 2); ctx.fill();
        }
      } else if (this.kind === 'spider') {
        // عناكب البحر السوداء: 6 أرجل طويلة ملتوية و6 أعين حمراء
        const legWalk = Math.sin(this.animTime * 8) * 4;
        ctx.fillStyle = '#050708'; ctx.beginPath(); ctx.ellipse(0, 0, 9, 6, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#0a0d10'; ctx.lineWidth = 1.8;
        for (let i = -1; i <= 1; i++) {
          ctx.beginPath(); ctx.moveTo(i * 4, -4); ctx.lineTo(i * 12, -16 + legWalk * i); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(i * 4, 4); ctx.lineTo(i * 12, 16 - legWalk * i); ctx.stroke();
        }
        ctx.fillStyle = '#ff1122';
        for (let e = -3; e <= 3; e += 1.2) {
          ctx.beginPath(); ctx.arc(6, e, 0.8, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

    drawDumboAndTripod(ctx) {
      if (this.type === 'dumbo_octo') {
        const flap = Math.sin(this.animTime * 3) * 3;
        ctx.fillStyle = '#8a3c5a';
        ctx.beginPath(); ctx.ellipse(0, 0, 7.5, 6, 0, 0, Math.PI * 2); ctx.fill();
        // زعانف الأذن المرفرفة كالأجنحة
        ctx.fillStyle = '#a64d6e';
        ctx.beginPath(); ctx.ellipse(-1, -7, 3, 4.5 + flap, 0.4, 0, Math.PI * 2); ctx.fill();
      } else {
        // سمكة ثلاثية الأرجل بزعانف ركائز طويلة
        ctx.fillStyle = '#65737e';
        ctx.beginPath(); ctx.ellipse(0, 0, 11, 3.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = '#abb2bf'; ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.moveTo(3, 2); ctx.lineTo(1, 16);
        ctx.moveTo(-7, 2); ctx.lineTo(-12, 16);
        ctx.stroke();
      }
    }

    drawBenthic(ctx) {
      if (this.type === 'crab' || this.type === 'spider_crab') {
        ctx.fillStyle = this.type === 'crab' ? '#8a3324' : '#694129';
        ctx.beginPath(); ctx.ellipse(0, 0, 6, 4.5, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(-4, 0); ctx.lineTo(-8, 3);
        ctx.moveTo(4, 0); ctx.lineTo(8, 3);
        ctx.stroke();
      } else {
        // سمكة العقرب أو اللوبستر
        ctx.fillStyle = this.type === 'lobster' ? '#1c2e40' : '#853e2d';
        ctx.beginPath(); ctx.ellipse(0, 0, 8, 4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#d98236';
        ctx.fillRect(-2, -3, 3, 2);
      }
    }

    drawInvertebrate(ctx) {
      const p = Math.sin(this.animTime * 6) * 1.5;
      ctx.fillStyle = this.type === 'squid' ? 'rgba(235, 220, 210, 0.85)' : 'rgba(240, 130, 90, 0.85)';
      ctx.beginPath();
      ctx.moveTo(8, 0); ctx.lineTo(-5, -4); ctx.lineTo(-8, 0 + p); ctx.lineTo(-5, 4);
      ctx.closePath(); ctx.fill();
    }

    drawSessileOrEel(ctx) {
      if (this.type === 'conger') {
        const wave = Math.sin(this.animTime * 5) * 3;
        ctx.strokeStyle = '#2b3338'; ctx.lineWidth = 3.8; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(12, 0); ctx.quadraticCurveTo(0, wave, -16, -wave * 0.7);
        ctx.stroke();
      } else if (this.type === 'red_coral') {
        ctx.strokeStyle = '#b81d24'; ctx.lineWidth = 2.0;
        ctx.beginPath();
        ctx.moveTo(0, 0); ctx.lineTo(-2, -10); ctx.lineTo(4, -16);
        ctx.moveTo(-2, -10); ctx.lineTo(-6, -15);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#0f1416';
        ctx.beginPath(); ctx.arc(0, 0, 4.5, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // =========================================================================
  // 5.6 MARINE FAUNA SYSTEM (Manager & Object Pooling)
  // =========================================================================
  class MarineFaunaSystem {
    constructor(terrain) {
      this.terrain = terrain;
      this.poolSize = Quality.q.fauna; // السعة تتبع إعداد الجودة وتُحدَّث حياً
      this.creatures = [];
      for (let i = 0; i < 70; i++) {
        this.creatures.push(new MarineCreature());
      }
      this.bloodPuffs = [];
      for (let i = 0; i < 16; i++) {
        this.bloodPuffs.push({
          x: 0, y: 0, vx: 0, vy: 0, r: 0, a: 0, active: false
        });
      }
      this.spawnTimer = 0;
      this.predationTimer = 8;
      // كائن المجهول الغامض (The Unknown Stalker)
      this.unknown = {
        active: false, x: 0, y: 0, alpha: 0, timer: 0,
        audioCooldown: 30, twitch: 0, peekSide: 1
      };
      this.unknownAudio = null;
      this.unknownBuffer = null;
      this.unknownAudioCtx = null;
      this.unknownBus = null;
      this.unknownSource = null;
    }

    spawnBlood(x, y) {
      for (let i = 0; i < 3; i++) {
        const p = this.bloodPuffs.find(b => !b.active);
        if (!p) break;
        p.active = true;
        p.x = x + (Math.random() - 0.5) * 6;
        p.y = y + (Math.random() - 0.5) * 6;
        p.vx = (Math.random() - 0.5) * 12;
        p.vy = -Math.random() * 8;
        p.r = 2.5 + Math.random() * 2.5;
        p.a = 0.75;
      }
    }

    isConeHit(sx, sy, ld) {
      if (!ld) return false;
      const dist = Math.hypot(sx - ld.worldEmitX, sy - ld.worldEmitY);
      if (dist > ld.range + 30) return false;
      const a = Math.atan2(sy - ld.worldEmitY, sx - ld.worldEmitX);
      const d = Math.abs(Math.atan2(Math.sin(a - ld.safeAngle), Math.cos(a - ld.safeAngle)));
      return d < ld.coneAngle + 0.15;
    }

    trySpawn(cam, sub, diver) {
      if (this.creatures.filter(c => c.active).length >= this.poolSize) return;
      const free = this.creatures.find(c => !c.active);
      if (!free) return;

      const halfW = (cam.viewportWidth * 0.5) / cam.zoom;
      const halfH = (cam.viewportHeight * 0.5) / cam.zoom;
      const side = Math.random() < 0.5 ? -1 : 1;
      const sx = cam.x + side * (halfW + 60 + Math.random() * 90);
      let sy = cam.y + (Math.random() - 0.5) * (halfH * 1.6);

      // حظر التوليد على اليابسة يميناً أو داخل الجدار السحيق
      if (sx >= WORLD.SHORE_X - 100 || sx < 100) return;
      if (sy >= 1000 && sx >= this.terrain.getWallX(sy) - 20) return;
      if (sy < WORLD.WATER_Y + 12) return;

      const gy = this.terrain.getHeightAt(sx);
      const ry = this.terrain.getRockSurfaceAt ? this.terrain.getRockSurfaceAt(sx) : null;
      const surfY = ry !== null ? Math.min(gy, ry) : gy;
      if (surfY <= WORLD.WATER_Y + 18) return; // يابسة شاطئية ضحلة جداً

      const depthM = (Math.min(sy, surfY) - WORLD.WATER_Y) / WORLD.PIXELS_PER_METER;
      if (depthM < 1 || depthM > 11000) return;

      // قاعدة تناقص الكثافة الحقيقية: تقل فرص الظهور كلما ازداد العمق
      const densityFactor = depthM < 100 ? 1.0 : Math.max(0.12, 1.0 - Math.pow(depthM / 5000, 0.6) * 0.88);
      if (Math.random() > densityFactor) return;

      if (sub && sub.lightsOn && this.isConeHit(sx, sy, sub.lightData)) return;
      if (diver && diver.lightOn && this.isConeHit(sx, sy, diver.lightData)) return;

      const types = Object.keys(FAUNA_DEFS);
      const valid = [];
      for (const t of types) {
        const def = FAUNA_DEFS[t];
        const w = getSpeciesWeight(def, depthM);
        // ترجيح الندرة: الكائنات النادرة كالحيتان وأسماك الصياد لا تظهر إلا باحتمال خاص
        const rarity = def.rarity || 1.0;
        if (w > 0.05 && Math.random() < rarity) {
          valid.push({ type: t, weight: w });
        }
      }
      if (valid.length === 0) return;
      valid.sort((a, b) => b.weight - a.weight);
      const picked = valid[Math.floor(Math.random() * Math.min(2, valid.length))].type;
      const def = FAUNA_DEFS[picked];

      // ضبط موضع الكائنات القاعية والسابحة بدقة لمنع التوليد تحت الأرض
      if (def.kind === 'crawl' || def.kind === 'ambush' || def.kind === 'sessile' || def.kind === 'octo') {
        sy = surfY - 4;
      } else {
        if (sy >= surfY - 14) sy = surfY - 20;
        if (sy <= WORLD.WATER_Y + 12) sy = WORLD.WATER_Y + 16;
      }

      free.reset(picked, sx, sy, -side);
    }

    update(dt, cam, sub, diver) {
      this.spawnTimer += dt;
      if (this.spawnTimer > 1.2) {
        this.spawnTimer = 0;
        this.trySpawn(cam, sub, diver);
      }

      this.predationTimer += dt;
      if (this.predationTimer > 14) {
        this.predationTimer = 0;
        this.checkPredation();
      }

      // تحديث ترصد وهروب كائن المجهول
      this.updateUnknownStalker(dt, cam, sub, diver);

      // توسيع مدى بقاء الكائنات لمنع اختفائها أثناء وجود أي جزء منها
      const despawnW = (cam.viewportWidth * 0.5) / cam.zoom + 380;
      const despawnH = (cam.viewportHeight * 0.5) / cam.zoom + 380;

      for (const c of this.creatures) {
        if (!c.active) continue;
        c.update(dt, this.terrain, sub, diver);

        // إلغاء الكائنات فقط عندما تبتعد كلياً عن حدود الرؤية
        if (Math.abs(c.x - cam.x) > despawnW || Math.abs(c.y - cam.y) > despawnH) {
          c.active = false;
        }
      }

      for (const b of this.bloodPuffs) {
        if (!b.active) continue;
        b.x += b.vx * dt; b.y += b.vy * dt;
        b.r += 1.8 * dt; b.a -= 0.65 * dt;
        if (b.a <= 0) b.active = false;
      }
    }

    updateUnknownStalker(dt, cam, sub, diver) {
      const un = this.unknown;
      const target = sub && sub.occupied ? sub : diver;
      if (!target) return;
      const dM = (target.y - WORLD.WATER_Y) / WORLD.PIXELS_PER_METER;
      if (un.audioCooldown > 0) un.audioCooldown -= dt;

      if (!un.active && dM >= 1000) {
        // احتمالية الظهور تزداد في الأعماق من 3000م فما فوق
        const spawnChance = (dM >= 3000 ? 0.003 : 0.0008);
        if (Math.random() < spawnChance) {
          un.active = true;
          un.peekSide = Math.random() < 0.5 ? -1 : 1;
          const halfW = (cam.viewportWidth * 0.5) / cam.zoom;
          un.x = cam.x + un.peekSide * (halfW - 25);
          un.y = cam.y + (Math.random() - 0.5) * 120;
          un.alpha = 0;
          un.timer = 6 + Math.random() * 8;
          if (un.audioCooldown <= 0 && dM >= 3000) {
            this.playUnknownAudio();
            un.audioCooldown = 75;
          }
        }
      }

      if (!un.active) return;
      un.timer -= dt;
      un.alpha = Math.min(1, un.alpha + dt * 1.5);
      const dist = Math.hypot(target.x - un.x, target.y - un.y);
      const inSubLight = sub && sub.lightsOn && this.isConeHit(un.x, un.y, sub.lightData);
      const inDiverLight = diver && diver.lightOn && this.isConeHit(un.x, un.y, diver.lightData);

      // في حال اقترب اللاعب أو سقط عليه الضوء: اهتزاز متشنج وهروب سريع
      if (dist < 130 || inSubLight || inDiverLight || un.timer <= 0) {
        un.twitch = Math.sin(performance.now() * 0.06) * 12;
        un.x += un.peekSide * 240 * dt;
        un.alpha -= dt * 2.8;
        if (un.alpha <= 0) un.active = false;
      }
    }

    playUnknownAudio() {
      if (!this.unknownBuffer || !this.unknownAudioCtx) return;

      try {
        if (this.unknownSource) {
          try {
            this.unknownSource.stop();
          } catch (_) {}
        }

        const source = this.unknownAudioCtx.createBufferSource();
        const gain = this.unknownAudioCtx.createGain();

        source.buffer = this.unknownBuffer;
        gain.gain.value = 0.55;

        source.connect(gain);
        gain.connect(
          this.unknownBus || this.unknownAudioCtx.destination
        );

        source.start();
        this.unknownSource = source;
      } catch (err) {
        console.error(
          '[Audio] Unknown.mp3 playback failed:',
          err
        );
      }
    }

    checkPredation() {
      const preds = this.creatures.filter(c => c.active && c.kind === 'pred' && c.huntCooldown <= 0);
      if (preds.length === 0) return;
      const pred = preds[Math.floor(Math.random() * preds.length)];

      const prey = this.creatures.find(c => c.active && (c.kind === 'swim' || c.type === 'shrimp') && Math.hypot(c.x - pred.x, c.y - pred.y) < 130);
      if (!prey) return;

      const ang = Math.atan2(prey.y - pred.y, prey.x - pred.x);
      pred.vx = Math.cos(ang) * 95;
      pred.vy = Math.sin(ang) * 95;
      pred.huntCooldown = 22;
      prey.active = false;
      this.spawnBlood(prey.x, prey.y);

      for (const near of this.creatures) {
        if (near.active && near !== pred && Math.hypot(near.x - prey.x, near.y - prey.y) < 110) {
          near.fleeTimer = 2.0;
          near.vx = (Math.random() < 0.5 ? -1 : 1) * near.baseSpeed * 1.6;
        }
      }
    }

    draw(ctx, cam) {
      // توسيع هامش الرؤية ليغطي الحيتان والأسماك الكبيرة بالكامل دون أي بتر
      const drawMarginW = (cam.viewportWidth * 0.5) / cam.zoom + 260;
      const drawMarginH = (cam.viewportHeight * 0.5) / cam.zoom + 240;

      for (const c of this.creatures) {
        if (!c.active) continue;
        if (Math.abs(c.x - cam.x) > drawMarginW || Math.abs(c.y - cam.y) > drawMarginH) continue;
        c.draw(ctx);
      }

      ctx.save();
      for (const b of this.bloodPuffs) {
        if (!b.active) continue;
        ctx.fillStyle = `rgba(120, 22, 18, ${b.a.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.fill();
      }

      // رسم كائن المجهول الشبح المرعب
      const un = this.unknown;
      if (un.active && un.alpha > 0.02) {
        ctx.save();
        ctx.translate(un.x + un.twitch, un.y);
        ctx.fillStyle = `rgba(0, 0, 0, ${un.alpha.toFixed(3)})`;
        // جسد وأطراف بشرية مستطيلة طويلة ومشوهة
        ctx.beginPath(); ctx.ellipse(0, -12, 5, 14, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillRect(-2, 0, 4, 28);
        ctx.fillRect(-9, -6, 2.5, 34); ctx.fillRect(6.5, -6, 2.5, 34);
        // عينان بيضاوان ساطعتان تنظران للاعب
        ctx.fillStyle = `rgba(255, 255, 255, ${(un.alpha * 0.95).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(-2.5, -15, 1.4, 0, Math.PI * 2);
        ctx.arc(2.5, -15, 1.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    }

    drawLight(lCtx) {
      for (const c of this.creatures) {
        if (!c.active || !c.biolum) continue;
        const g = lCtx.createRadialGradient(c.x, c.y, 1, c.x, c.y, 22);
        g.addColorStop(0.0, 'rgba(100, 240, 255, 0.85)');
        g.addColorStop(0.5, 'rgba(30, 140, 220, 0.25)');
        g.addColorStop(1.0, 'rgba(0, 0, 0, 0)');
        lCtx.fillStyle = g;
        lCtx.beginPath(); lCtx.arc(c.x, c.y, 22, 0, Math.PI * 2); lCtx.fill();
      }
    }
  }

  class OpticsSystem {
    constructor() {
      this.time = 0;
      this.clouds = [
        { x: 1200, y: 85, scale: 1.1, speed: 4.5 },
        { x: 3600, y: 140, scale: 0.85, speed: 3.2 },
        { x: 6000, y: 95, scale: 1.35, speed: 5.0 },
        { x: 8400, y: 160, scale: 0.95, speed: 3.8 },
        { x: 10800, y: 75, scale: 1.2, speed: 4.2 }
      ];

      // عوالق مائية خفيفة ومعدودة مع دورة حياة محددة
      this.particles = [];
      const rng = new DeterministicRNG(998877);
      for (let i = 0; i < 42; i++) {
        const life = rng.range(3.5, 7.0);
        this.particles.push({
          x: rng.range(WORLD.WALL_X, WORLD.SHORE_X),
          y: rng.range(WORLD.WATER_Y + 15, WORLD.WATER_Y + 900),
          r: rng.range(0.9, 1.8),
          speedY: rng.range(3, 8),
          driftPhase: rng.range(0, Math.PI * 2),
          alpha: rng.range(0.18, 0.45),
          life: life,
          maxLife: life
        });
      }
    }

    update(dt) {
      this.time += dt;

      // حركة السحب البطيئة
      for (const cloud of this.clouds) {
        cloud.x += cloud.speed * dt;
        if (cloud.x > WORLD.WIDTH + 150) {
          cloud.x = -200;
        }
      }

      // حركة العوالق الدقيقة مع حصرها بنطاق الكاميرا لتوفير المعالجة
      for (const p of this.particles) {
        p.y += p.speedY * dt;
        p.x += Math.sin(this.time * 0.8 + p.driftPhase) * 6 * dt;
      }
    }

    recycleParticlesAround(camX, camY, vW, vH) {
      const padW = vW * 0.55, padH = vH * 0.55;
      for (const p of this.particles) {
        p.life -= 0.016;
        const outOfView = p.x < camX - padW || p.x > camX + padW ||
                          p.y < camY - padH || p.y > camY + padH;
        if (outOfView || p.life <= 0 || p.x >= WORLD.SHORE_X - 15) {
          p.x = Math.max(WORLD.WALL_X + 20, Math.min(WORLD.SHORE_X - 25, camX + (Math.random() - 0.5) * (vW * 1.05)));
          const wY = this.getWaterHeightAt(p.x);
          p.y = Math.max(wY + 14, camY + (Math.random() - 0.5) * (vH * 1.05));
          p.life = 4.0 + Math.random() * 4.0;
          p.maxLife = p.life;
        }
      }
    }

    getWaterHeightAt(x) {
      // سطح بحر هادئ جداً بأمواج بطيئة وخفيفة للغاية
      const t = this.time;
      const w1 = Math.sin(x * 0.008 + t * 0.75) * 1.1;
      const w2 = Math.cos(x * 0.018 - t * 0.5) * 0.4;

      // تخميد ناعم عند الاقتراب من خط الشاطئ
      const shoreDamping = Math.max(0, Math.min(1, (WORLD.SHORE_X - x) / 220));
      return WORLD.WATER_Y + (w1 + w2) * shoreDamping;
    }
  }

  // =========================================================================
  // 6.3 DAY & NIGHT SYSTEM (دورة 24 دقيقة وتخزين مستمر)
  // =========================================================================
  class DayNightSystem {
    constructor() {
      this.cycleDuration = 1440; // 24 دقيقة = 1440 ثانية
      this.time = this.loadTime();
      this.saveTimer = 0;
      this.skyTop = '#5fa8dc';
      this.skyMid = '#8ec8ea';
      this.skyBot = '#1e6694';
      this.ambientTop = '#ffffff';
      this.ambientMid = '#aaccff';
      this.starAlpha = 0;
      this.weather = 'cloud'; // مشمس sun / مغيم cloud / عاصفة storm / ثلج snow
      this.weatherTimer = 20;
      this.phaseName = 'ظهيرة';
      this.updateColors();
    }

    loadTime() {
      try {
        const v = parseFloat(localStorage.getItem('marine_cycle_time'));
        if (Number.isFinite(v) && v >= 0 && v < 1440) return v;
      } catch (_) {}
      return 720; // الافتراضي: 12:00 ظهيرة (720 ثانية)
    }

    saveTime() {
      try {
        localStorage.setItem('marine_cycle_time', this.time.toFixed(1));
      } catch (_) {}
    }

    update(dt) {
      this.time = (this.time + dt) % this.cycleDuration;

      // تبديل الطقس كل ~2.5 دقيقة باحتمالات (الجو المغيم هو الأرجح)
      this.weatherTimer += dt;
      if (this.weatherTimer >= 150) {
        this.weatherTimer = 0;
        const r = Math.random();
        this.weather = r < 0.28 ? 'sun' : (r < 0.62 ? 'cloud' : (r < 0.82 ? 'storm' : 'snow'));
      }

      this.saveTimer += dt;
      if (this.saveTimer >= 4.0) {
        this.saveTimer = 0;
        this.saveTime();
      }
      this.updateColors();
    }

    getTimeString() {
      const totalMinutes = (this.time / this.cycleDuration) * 1440;
      const h = Math.floor(totalMinutes / 60);
      const m = Math.floor(totalMinutes % 60);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    updateColors() {
      const p = this.time / this.cycleDuration;
      const stops = [
        { t: 0.00, st: [2,5,14], sm: [6,16,32], sb: [10,22,40], at: [24,32,54], am: [16,22,38], sa: 0.95, n: 'ليل' },
        { t: 0.21, st: [16,20,38], sm: [48,34,52], sb: [75,42,48], at: [60,52,72], am: [38,34,50], sa: 0.65, n: 'فجر' },
        { t: 0.28, st: [45,62,110], sm: [218,118,84], sb: [245,172,108], at: [215,168,152], am: [160,142,168], sa: 0.0, n: 'شروق' },
        { t: 0.38, st: [74,138,208], sm: [138,190,230], sb: [44,115,168], at: [246,248,255], am: [168,198,238], sa: 0.0, n: 'صباح' },
        { t: 0.50, st: [95,168,220], sm: [142,200,234], sb: [30,102,148], at: [255,255,255], am: [170,204,255], sa: 0.0, n: 'ظهيرة' },
        { t: 0.66, st: [86,146,206], sm: [162,192,212], sb: [46,102,142], at: [255,242,225], am: [175,200,235], sa: 0.0, n: 'عصر' },
        { t: 0.75, st: [46,28,80], sm: [220,78,48], sb: [235,135,45], at: [250,140,75], am: [188,98,68], sa: 0.0, n: 'غروب' },
        { t: 0.83, st: [18,16,46], sm: [70,38,64], sb: [34,28,52], at: [68,50,80], am: [42,34,58], sa: 0.55, n: 'غسق' },
        { t: 0.90, st: [2,5,14], sm: [6,16,32], sb: [10,22,40], at: [24,32,54], am: [16,22,38], sa: 0.95, n: 'ليل' },
        { t: 1.00, st: [2,5,14], sm: [6,16,32], sb: [10,22,40], at: [24,32,54], am: [16,22,38], sa: 0.95, n: 'ليل' }
      ];

      let s0 = stops[0], s1 = stops[1];
      for (let i = 0; i < stops.length - 1; i++) {
        if (p >= stops[i].t && p <= stops[i+1].t) {
          s0 = stops[i]; s1 = stops[i+1]; break;
        }
      }
      const f = (p - s0.t) / (s1.t - s0.t);
      const lerp = (a, b) => Math.round(a + (b - a) * f);
      const toRgb = (c0, c1) => `rgb(${lerp(c0[0], c1[0])}, ${lerp(c0[1], c1[1])}, ${lerp(c0[2], c1[2])})`;

      this.skyTop = toRgb(s0.st, s1.st);
      this.skyMid = toRgb(s0.sm, s1.sm);
      this.skyBot = toRgb(s0.sb, s1.sb);
      this.ambientTop = toRgb(s0.at, s1.at);
      this.ambientMid = toRgb(s0.am, s1.am);
      this.starAlpha = s0.sa + (s1.sa - s0.sa) * f;
      this.phaseName = (f > 0.5) ? s1.n : s0.n;
    }
  }

  // =========================================================================
  // 6.4 UNIFIED AUDIO MANAGER & MIXER (إدارة مركزية موحدة تمنع التسريب والتقطيع)
  // =========================================================================
  class AudioManager {
    constructor() {
      this.ctx = null;
      this.masterGain = null;
      this.subBus = null;
      this.ambientBus = null;
      this.sfxBus = null;
      this.unlocked = false;
      this.lastCollisionTime = 0;
    }

    init() {
      if (this.ctx) return;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.85;
        this.masterGain.connect(this.ctx.destination);

        // قنوات التحكم الفرعية (Mixer Busses)
        this.subBus = this.ctx.createGain();
        this.subBus.gain.value = 0.9;
        this.subBus.connect(this.masterGain);

        this.ambientBus = this.ctx.createGain();
        this.ambientBus.gain.value = 0.75;
        this.ambientBus.connect(this.masterGain);

        this.sfxBus = this.ctx.createGain();
        this.sfxBus.gain.value = 0.6;
        this.sfxBus.connect(this.masterGain);
      } catch (_) { this.ctx = null; }
    }

    unlock() {
      this.init();
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      this.unlocked = true;
    }

    suspend() {
      if (this.ctx && this.ctx.state === 'running') {
        this.ctx.suspend().catch(() => {});
      }
    }

    resume() {
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
    }

    // صوت اصطدام ناعم وواقعي لهيكل الغواصة مع نظام Cooldown لمنع التكدس
    playHullImpact(speed) {
      if (!this.ctx || !this.unlocked || speed < 25) return;
      const now = this.ctx.currentTime;
      if (now - this.lastCollisionTime < 0.35) return; // منع التكرار المزعج
      this.lastCollisionTime = now;

      try {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        const filter = this.ctx.createBiquadFilter();

        osc.type = 'sine';
        osc.frequency.setValueAtTime(80, now);
        osc.frequency.exponentialRampToValueAtTime(32, now + 0.18);

        filter.type = 'lowpass';
        filter.frequency.value = 140;

        const vol = Math.min(0.4, (speed / 250) * 0.35);
        gain.gain.setValueAtTime(vol, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

        osc.connect(filter);
        filter.connect(gain);
        gain.connect(this.sfxBus);

        osc.start(now);
        osc.stop(now + 0.24);

        osc.onended = () => {
          try {
            osc.disconnect();
            filter.disconnect();
            gain.disconnect();
          } catch (_) {}
        };
      } catch (_) {}
    }
  }

  // محرك صوت الغواصة الاصطناعي المستمر (بدون ملفات وبدون أي ضغط على الـ CPU)
  class SubmarineEngineSound {
    constructor(audioMgr) {
      this.mgr = audioMgr;
      this.osc = null;
      this.filter = null;
      this.gain = null;
      this.running = false;
    }

    start() {
      if (this.running || !this.mgr.ctx) return;
      try {
        const ctx = this.mgr.ctx;
        this.osc = ctx.createOscillator();
        this.filter = ctx.createBiquadFilter();
        this.gain = ctx.createGain();

        this.osc.type = 'triangle';
        this.osc.frequency.value = 34; // نغمة المحرك التحت مائية المنخفضة

        this.filter.type = 'lowpass';
        this.filter.frequency.value = 95;

        this.gain.gain.value = 0.0001;

        this.osc.connect(this.filter);
        this.filter.connect(this.gain);
        this.gain.connect(this.mgr.subBus);

        this.osc.start();
        this.running = true;
      } catch (_) { this.running = false; }
    }

    update(speed, occupied) {
      if (!occupied) {
        if (this.running) this.stop();
        return;
      }
      if (!this.running) this.start();
      if (!this.running || !this.gain || !this.mgr.ctx) return;

      const t = this.mgr.ctx.currentTime;
      const spdRatio = Math.min(1.0, speed / 260);

      // تحديث سلس ومستمر لتردد ونغمة الصوت بدوال Ramp التلقائية (مستقلة تماماً عن الـ FPS)
      const targetFreq = 34 + spdRatio * 32;
      const targetFilter = 95 + spdRatio * 110;
      const targetVol = 0.08 + spdRatio * 0.18;

      this.osc.frequency.setTargetAtTime(targetFreq, t, 0.2);
      this.filter.frequency.setTargetAtTime(targetFilter, t, 0.2);
      this.gain.gain.setTargetAtTime(targetVol, t, 0.2);
    }

    stop() {
      if (!this.running) return;
      this.running = false;
      if (this.gain && this.mgr.ctx) {
        try {
          this.gain.gain.setTargetAtTime(0.0001, this.mgr.ctx.currentTime, 0.1);
        } catch (_) {}
      }
      setTimeout(() => {
        if (this.osc) {
          try { this.osc.stop(); this.osc.disconnect(); } catch (_) {}
          this.osc = null;
        }
        if (this.filter) {
          try { this.filter.disconnect(); } catch (_) {}
          this.filter = null;
        }
        if (this.gain) {
          try { this.gain.disconnect(); } catch (_) {}
          this.gain = null;
        }
      }, 150);
    }
  }





  // =========================================================================
  // 6.5 PRELOADER & INTRO FLOW MANAGER
  // =========================================================================
  class IntroFlowManager {
    constructor(onComplete) {
      this.onComplete = onComplete;
      this.flowEl = document.getElementById('intro-flow');
      this.startEl = document.getElementById('start-overlay');
      this.prestartEl = document.getElementById('prestart-overlay');
      this.comicEl = document.getElementById('comic-overlay');
      if (this.startEl) this.startEl.classList.add('hidden');
      this._assetsReady = false;
      this.loadEl = document.getElementById('loading-overlay');
      this.barEl = document.getElementById('loading-progress');
      this.pctEl = document.getElementById('loading-percent');
      this.progress = 0;
      this.preloadedAudio = {};

      // تفعيل المستمعات دائماً لضمان لمسة المستخدم لفك الصوت
      this.initEvents();

      // استرجاع مستوى الصوت المحفوظ لواجهة اللوبي
      try {
        const savedVol = parseFloat(localStorage.getItem('marine_master_vol'));
        const volInput = document.getElementById('lobby-volume');
        if (Number.isFinite(savedVol) && volInput) {
          volInput.value = String(Math.round(savedVol * 100));
        }
      } catch (_) {}

      // استرجاع جودة الرسومات المحفوظة لمحدد اللوبي
      try {
        const qSelEl = document.getElementById('lobby-quality');
        if (qSelEl) qSelEl.value = Quality.level;
      } catch (_) {}

      // جلب ملفات الصوت مسبقاً أثناء عرض الـLobby (fetch فقط — فك الترميز بعد اللمسة)
      this.prefetchedBuffers = {};
      const preList = [
        ['whale', 'voices/bluewhale.mp3'],
        ['diving', 'voices/divingsound.mp3'],
        ['warning', 'voices/warning.mp3'],
        ['unknown', 'voices/Unknown.mp3']
      ];
      let preDone = 0;
      const statusEl0 = document.getElementById('lobby-status');
      if (statusEl0) statusEl0.textContent = 'جاري تجهيز الموارد...';
      for (const [pKey, pUrl] of preList) {
        fetch(pUrl)
          .then((r) => { if (!r.ok) throw new Error('nf'); return r.arrayBuffer(); })
          .then((ab) => { this.prefetchedBuffers[pKey] = ab; })
          .catch(() => {})
          .finally(() => {
            preDone++;
            if (statusEl0) {
              statusEl0.textContent = preDone >= preList.length
                ? 'كل شيء جاهز'
                : `جاري تجهيز الموارد... ${Math.round((preDone / preList.length) * 100)}%`;
            }
          });
      }
    }

    markIntroCompleted() {
      try {
        localStorage.setItem('marine_intro_seen', '1');
      } catch (_) {}
    }

    // ---------------------------------------------------------------------
    // شريط التحميل (كتابة مباشرة بدون قيد التصاعد)
    // ---------------------------------------------------------------------
    setBar(val) {
      const v = Math.min(100, Math.max(0, val));
      if (this.barEl) this.barEl.style.width = `${v}%`;
      if (this.pctEl) this.pctEl.textContent = `${Math.round(v)}%`;
    }

    setProgress(val) {
      this.progress = Math.min(100, Math.max(this.progress, val));
      this.setBar(this.progress);
    }



        initEvents() {
      if (this.prestartEl) {
        const onPreTap = (e) => {
          e.stopPropagation();
          this.unlockAudioOnGesture();
          this.lockLandscapeAndFullscreen();
          GameLogger.log('FLOW', 'INFO', 'Prestart tapped');
          this.prestartEl.classList.add('hidden');
          this.goToLoader();
        };
        this.prestartEl.addEventListener('pointerup', onPreTap);
        this.prestartEl.addEventListener('click', onPreTap);
      }
      if (!this.startEl) return;

      const onStartTap = (e) => {
        e.stopPropagation();
        GameLogger.log('FLOW', 'INFO', 'Lobby start tapped');

        // الموارد جاهزة مسبقاً: ابدأ اللعبة فوراً دون شريط تحميل ثانٍ
        if (this._assetsReady) {
          this.startGame();
          return;
        }

        // منع تكرار الضغط أثناء التجهيز
        const menu = this.startEl.querySelector('.lobby-menu');
        if (menu) menu.classList.add('is-busy');
        const status = document.getElementById('lobby-status');
        if (status) status.textContent = 'جاري تجهيز الأصوات...';

        // فك الصوت أولاً
        this.unlockAudioOnGesture();

        this.goToLoader();

        this.lockLandscapeAndFullscreen();
      };

      const btnStartEl = document.getElementById('btn-start');
      if (btnStartEl) {
        btnStartEl.addEventListener('pointerup', onStartTap);
        btnStartEl.addEventListener('click', onStartTap);
      }
      const btnContinueEl = document.getElementById('btn-continue');
      if (btnContinueEl) {
        btnContinueEl.addEventListener('pointerup', onStartTap);
        btnContinueEl.addEventListener('click', onStartTap);
      }

      // نوافذ اللوبي المصغرة: إعدادات / ويب / أخبار / متجر
      const modalPairs = [
        ['btn-lobby-settings', 'lobby-modal-settings'],
        ['btn-lobby-online', 'lobby-modal-online'],
        ['btn-lobby-web', 'lobby-modal-web'],
        ['btn-lobby-news', 'lobby-modal-news'],
        ['btn-lobby-store', 'lobby-modal-store']
      ];
      for (const [btnId, modalId] of modalPairs) {
        const b = document.getElementById(btnId);
        const m = document.getElementById(modalId);
        if (!b || !m) continue;
        const openModal = (e) => {
          e.stopPropagation();
          m.classList.remove('hidden');
        };
        b.addEventListener('pointerup', openModal);
        b.addEventListener('click', openModal);
      }
      const closeBtns = this.startEl.querySelectorAll('.lobby-modal-close');
      for (const cb of closeBtns) {
        const closeModal = (e) => {
          e.stopPropagation();
          const targetId = cb.getAttribute('data-close');
          const m = targetId ? document.getElementById(targetId) : null;
          if (m) m.classList.add('hidden');
        };
        cb.addEventListener('pointerup', closeModal);
        cb.addEventListener('click', closeModal);
      }

      // حفظ مستوى الصوت الرئيسي من اللوبي
      const volInput = document.getElementById('lobby-volume');
      if (volInput) {
        volInput.addEventListener('input', () => {
          const v = Math.max(0, Math.min(100, parseInt(volInput.value, 10) || 0)) / 100;
          try { localStorage.setItem('marine_master_vol', String(v)); } catch (_) {}
        });
      }

    }


    unlockAudioOnGesture() {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC && !this.audioCtx) {
          this.audioCtx = new AC();
        }
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
          this.audioCtx.resume().catch(() => {});
        }
      } catch (_) {}
    }

    lockLandscapeAndFullscreen() {
      try {
        if (document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(() => {});
        }
      } catch (_) {}
      try {
        if (screen.orientation && screen.orientation.lock) {
          screen.orientation.lock('landscape').catch(() => {});
        }
      } catch (_) {}
      // إعادة فرض القفل الأفقي فور أي تغيير في اتجاه الجهاز
      try {
        if (!this._orientationLocked) {
          this._orientationLocked = true;
          window.addEventListener('orientationchange', () => {
            setTimeout(() => {
              try {
                if (screen.orientation && screen.orientation.lock) {
                  screen.orientation.lock('landscape').catch(() => {});
                }
                if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
                  document.documentElement.requestFullscreen().catch(() => {});
                }
              } catch (_) {}
            }, 300);
          });
        }
      } catch (_) {}
    }

    goToLoader() {
      if (this.startEl) this.startEl.classList.add('hidden');
      if (this.loadEl) this.loadEl.classList.remove('hidden');
      this.progress = 0;
      this.runPreloader();
    }



    async runPreloader() {
      this.setProgress(10);
      if (!this.audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = AC ? new AC() : null;
      }
      const audioCtx = this.audioCtx;
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
      }

      let loaded = 0;
      const TOTAL_SOUNDS = 4;

      const loadSound = async (url, key) => {
        // استخدام المخزن المسبق من الـLobby إن وُجد (fetch تم أثناء القائمة)
        if (key && this.prefetchedBuffers && this.prefetchedBuffers[key] && audioCtx) {
          try {
            const cachedBuf = await audioCtx.decodeAudioData(this.prefetchedBuffers[key]);
            loaded++;
            this.setProgress(20 + (loaded / TOTAL_SOUNDS) * 70);
            return cachedBuf;
          } catch (_) { /* نكمل بالتحميل العادي */ }
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, 8000);

        try {
          const res = await fetch(url, {
            signal: controller.signal,
            cache: 'no-store'
          });

          if (!res.ok) {
            console.error('[Audio] HTTP load failed:', url, res.status, res.statusText);
            return null;
          }

          const ab = await res.arrayBuffer();

          if (!audioCtx) {
            GameLogger.log('ASSET', 'ERR',
              'No AudioContext for ' + url);
            return null;
          }

          const buf = await audioCtx
            .decodeAudioData(ab);
          GameLogger.log('ASSET',
            'SUCCESS',
            'Loaded & decoded: ' + url, {
              duration: buf.duration.toFixed(2)
            });
          return buf;
        } catch (err) {
          GameLogger.log('ASSET', 'ERR',
            'Failed audio: ' + url, {
              err: String(err)
            });
          return null;
        } finally {
          clearTimeout(timeoutId);
          // الشريط يتحرك مع انتهاء كل ملف صوتي بدل القفز دفعة واحدة
          loaded++;
          this.setProgress(20 + (loaded / TOTAL_SOUNDS) * 70);
        }
      };

      this.setProgress(20);

      const audioResults = await Promise.all([
        loadSound('voices/bluewhale.mp3', 'whale'),
        loadSound('voices/divingsound.mp3', 'diving'),
        loadSound('voices/warning.mp3', 'warning'),
        loadSound('voices/Unknown.mp3', 'unknown')
      ]);

      this.preloadedAudio.whale = audioResults[0];
      this.preloadedAudio.diving = audioResults[1];
      this.preloadedAudio.warning = audioResults[2];
      this.preloadedAudio.unknown = audioResults[3];
      this.setProgress(90);

      await new Promise((r) => setTimeout(r, 180));
      this.setProgress(100);

      await new Promise((r) => setTimeout(r, 220));

      this._assetsReady = true;

      // عرض المقدمة الكوميكية في أول زيارة فقط
      let seen = false;
      try { seen = localStorage.getItem('marine_intro_seen') === '1'; } catch (_) {}
      if (!seen) {
        this.showComic(() => this.showLobby());
      } else {
        this.showLobby();
      }
    }

    // إظهار الـLobby بتلاشٍ متدرج بعد التجهيز أو بعد المقدمة
    showLobby() {
      if (this.loadEl) this.loadEl.classList.add('hidden');
      if (this.startEl) {
        this.startEl.classList.remove('hidden');
        this.startEl.classList.add('fade-in');
      }
    }

    // بدء اللعبة بعد اكتمال كل الموارد (يُعلَّم أن المقدمة شوهدت)
    startGame() {
      if (this._gameStarted) return;
      this._gameStarted = true;
      this.markIntroCompleted();
      if (this.flowEl) this.flowEl.classList.add('finished');
      if (this.onComplete) this.onComplete(this.preloadedAudio, this.audioCtx);
    }

    // تجاوز فوري وتخطي سريع مباشر للمطور
    fastSkipDirectly() {
      GameLogger.log('DEV', 'INFO', 'Fast Skip Triggered');
      this.unlockAudioOnGesture();
      this.markIntroCompleted();
      if (this.comicEl) this.comicEl.classList.add('hidden');
      if (this.loadEl) this.loadEl.classList.add('hidden');
      if (this.startEl) this.startEl.classList.add('hidden');
      if (this.prestartEl) this.prestartEl.classList.add('hidden');
      this.startGame();
    }

    // عرض المقدمة الكوميكية المدمجة (أول زيارة) ثم تلاشيها نحو الـLobby
    showComic(onDone) {
      if (this.loadEl) this.loadEl.classList.add('hidden');
      if (!this.comicEl) { if (onDone) onDone(); return; }

      this.comicEl.classList.remove('hidden');
      this.comicEl.classList.add('fade-in');

      let finished = false;
      let bailTimer = null;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (bailTimer) clearTimeout(bailTimer);
        window.__comicDone = null;
        this.comicEl.classList.add('fade-out');
        setTimeout(() => {
          this.comicEl.classList.add('hidden');
          this.comicEl.classList.remove('fade-in', 'fade-out');
          if (onDone) onDone();
        }, 700);
      };

      // احتياط: تجاوز المقدمة إذا تعطل النظام (3 دقائق كحد أقصى)
      bailTimer = setTimeout(finish, 180000);

      // انتهاء القصة يصل مباشرة من زر "الانتقال إلى اللعبة" داخل نفس الصفحة
      window.__comicDone = finish;

      if (window.ComicIntro && window.ComicIntro.start) {
        window.ComicIntro.start();
      } else {
        finish();
      }
    }
  }

  // =========================================================================
  // 6.5 WHALE CALL AUDIO SYSTEM (صوت الحوت الأزرق — مؤقت + فرصة عمق + غلاف صوتي)
  // =========================================================================
  class WhaleCallSystem {
    constructor() {
      this.audio = null;      // AudioContext (يُنشأ بعد أول لمسة فقط)
      this.buffer = null;     // الصوت مفكوك الترميز (المسار الأساسي)
      this.element = null;    // عنصر صوت بديل لمسار file://
      this.ready = false;
      this.loadFailed = false;
      this.state = 'idle';    // idle | waiting | playing
      this.timer = 0;
      this.closeCooldown = 0; // منع تكرار الحدث القريب بسرعة
      this.src = null; this.envGain = null; this.pan = null;
      this.env = null;
      this.elT = 0; this.elPeak = 0;
    }

    // نسب الفرصة حسب العمق — تُستخدم عند انتهاء المؤقت فقط (لا فحص كل فريم)
    chanceFor(d) {
      if (d < 15) return 0;
      if (d < 60) return 0.25;
      if (d < 250) return 0.65;
      if (d < 700) return 0.85;
      if (d < 1500) return 0.55;
      if (d < 5000) return 0.38;
      if (d <= 11000) return 0.24;
      return 0;
    }

    scheduleNext() {
      this.state = 'waiting';
      this.timer = 18 + Math.random() * 24; // كل 18–42 ثانية
    }

    initAudio(sharedAudioMgr) {
      if (this.ready || this.loadFailed) { this._resume(); return; }
      this.mgr = sharedAudioMgr || null;
      this.audio = (this.mgr && this.mgr.ctx) ? this.mgr.ctx : null;
      this.master = (this.mgr && this.mgr.ambientBus) ? this.mgr.ambientBus : null;

      if (this.audio && !this.master) {
        this.master = this.audio.createGain();
        this.master.gain.value = 0.85;
        this.master.connect(this.audio.destination);
      }

      if (this.audio) {
        fetch('voices/bluewhale.mp3')
          .then((r) => { if (!r.ok) throw new Error('nf'); return r.arrayBuffer(); })
          .then((ab) => this.audio.decodeAudioData(ab))
          .then((buf) => { this.buffer = buf; this.ready = true; })
          .catch(() => this._loadElementFallback());
      } else {
        this._loadElementFallback();
      }
    }

    _loadElementFallback() {
      // تحميل وصفي خفيف لا يحجز مسار المعالجة الرئيسي لنظام أندرويد
      try {
        const el = new Audio();
        el.preload = 'metadata';
        el.src = 'voices/bluewhale.mp3';
        el.addEventListener('canplaythrough', () => { this.element = el; this.ready = true; }, { once: true });
        el.addEventListener('error', () => { this.loadFailed = true; }, { once: true });
      } catch (_) { this.loadFailed = true; }
    }

    _resume() {
      if (this.audio && this.audio.state === 'suspended') this.audio.resume().catch(() => {});
    }

    update(dt, depthM) {
      if (this.closeCooldown > 0) this.closeCooldown -= dt;
      if (!this.ready || this.loadFailed) return;

      if (this.state === 'playing') { this._updatePlaying(dt); return; }

      // زر التجربة: تشغيل فوري بمجرد جهزية الصوت
      if (this._pendingTest) {
        if (!this.ready) return;
        this._pendingTest = false;
        this._startCall();
        return;
      }

      const ch = this.chanceFor(depthM);
      if (this.state === 'waiting') {
        if (ch <= 0) { this.state = 'idle'; return; }
        this.timer -= dt;
        if (this.timer <= 0) {
          if (Math.random() < ch) this._startCall(depthM);
          else this.scheduleNext();
        }
      } else if (this.state === 'idle' && ch > 0) {
        this.scheduleNext();
      }
    }

    // زر التجربة: تشغيل فوري بتجاوز المؤقت والاحتمال (للاختبار فقط)
    testCall() {
      if (!this.audio && !this.element && !this.loadFailed) this.initAudio();
      this._resume();
      if (this.state === 'playing') return; // لا تكرار أثناء تشغيل
      if (this.ready) this._startCall();
      else this._pendingTest = true; // يشتغل تلقائياً فور تحميل الملف
    }

    _startCall(depthM = 0) {
      if (this.state === 'playing') return; // حظر التزامن: صوت واحد فقط قطعي
      const r = Math.random();
      let mode = 'far';
      if (this.closeCooldown <= 0 && r < 1 / 20) { mode = 'close'; this.closeCooldown = 300; }
      else if (r < 1 / 20 + 0.20) mode = 'mid';

      let peak;
      if (mode === 'far') peak = 0.10 + Math.random() * 0.06;
      else if (mode === 'mid') peak = 0.28 + Math.random() * 0.10;
      else peak = 0.70;

      // كتم وتخفيض صوت الحوت تدريجياً في الأعماق السحيقة (1000م - 11000م)
      if (depthM > 1000) {
        const deepMuffle = Math.max(0.18, 1.0 - ((depthM - 1000) / 10000) * 0.75);
        peak *= deepMuffle;
      }

      if (this.buffer && this.audio) {
        try { this._startWebAudio(mode, peak); }
        catch (_) { this._startElement(peak); return; }
      } else if (this.element) {
        this._startElement(peak);
      } else { return; }
      this.state = 'playing';
    }

    _startWebAudio(mode, peak) {
      const dur = Math.min(this.buffer.duration, 8);
      this.src = this.audio.createBufferSource();
      this.src.buffer = this.buffer;
      this.envGain = this.audio.createGain();
      this.src.connect(this.envGain);

      // صدى خفيف جداً للحالة المتوسطة مع حفظ العقد لفصلها لاحقاً
      if (mode === 'mid') {
        try {
          const delay = this.audio.createDelay(1.0);
          delay.delayTime.value = 0.28;
          const fb = this.audio.createGain(); fb.gain.value = 0.25;
          const wet = this.audio.createGain(); wet.gain.value = 0.35;
          this.envGain.connect(delay);
          delay.connect(fb); fb.connect(delay);
          delay.connect(wet); wet.connect(this.master);
          this.echoNodes = [delay, fb, wet];
        } catch (_) {}
      }

      // اتجاه يتغير قليلاً — اللاعب لا يعرف أمامه أم خلفه
      this.pan = null;
      if (this.audio.createStereoPanner) {
        this.pan = this.audio.createStereoPanner();
        this.panBase = (Math.random() * 2 - 1) * 0.8;
        this.panDrift = (Math.random() * 2 - 1) * 0.35;
        this.envGain.connect(this.pan);
        this.pan.connect(this.master);
      } else {
        this.envGain.connect(this.master);
      }

      this.env = { t: 0, dur, attack: 2.0, release: 2.5, peak };
      this.envGain.gain.value = 0.0001;
      this.src.start();
    }

    _startElement(peak) {
      const el = this.element;
      el.volume = 0.0001;
      try { el.currentTime = 0; } catch (_) {}
      this.elPeak = peak;
      this.elT = 0;
      el.play().catch(() => {});
    }

    _updatePlaying(dt) {
      if (this.envGain && this.env) {
        const e = this.env;
        e.t += dt;
        // الغلاف: ظهور تدريجي → ذروة → اختفاء تدريجي
        let v;
        if (e.t < e.attack) v = e.t / e.attack;
        else if (e.t < e.dur - e.release) v = 1;
        else v = Math.max(0, (e.dur - e.t) / e.release);
        this.envGain.gain.setTargetAtTime(Math.max(0.0001, v * e.peak), this.audio.currentTime, 0.08);
        if (this.pan) {
          this.pan.pan.setTargetAtTime(
            Math.max(-1, Math.min(1, this.panBase + Math.sin(e.t * 0.5) * this.panDrift)),
            this.audio.currentTime, 0.3);
        }
        if (e.t >= e.dur + 0.3) {
          // تفريغ وفصل العقد فور اكتمال الصوت لمنع تراكمها في الذاكرة
          if (this.src) {
            try { this.src.stop(); this.src.disconnect(); } catch (_) {}
            this.src = null;
          }
          if (this.envGain) {
            try { this.envGain.disconnect(); } catch (_) {}
            this.envGain = null;
          }
          if (this.pan) {
            try { this.pan.disconnect(); } catch (_) {}
            this.pan = null;
          }
          if (this.echoNodes) {
            for (const n of this.echoNodes) { try { n.disconnect(); } catch (_) {} }
            this.echoNodes = null;
          }
          this.env = null;
          this.scheduleNext();
        }
      } else if (this.element) {
        this.elT += dt;
        const el = this.element;
        const metaDur = isFinite(el.duration) ? el.duration : 8;
        const dur = Math.min(metaDur, 8);
        let v;
        if (this.elT < 2) v = this.elT / 2;
        else if (this.elT < dur - 2.5) v = 1;
        else v = Math.max(0, (dur - this.elT) / 2.5);
        el.volume = Math.max(0.0001, Math.min(1, v * this.elPeak));
        if (this.elT >= dur) {
          try { el.pause(); } catch (_) {}
          this.elT = 0;
          this.scheduleNext();
        }
      }
    }
  }

  // =========================================================================
  // 6.6 SUBMARINE BEACON SYSTEM (صامت تماماً مع الحفاظ على التوافق)
  // =========================================================================
  class SubmarineRingAudio {
    constructor() {
      this.ready = true;
      this.playing = false;
      this.started = false;
    }
    init() {}
    resume() {}
    start() { this.playing = true; this.started = true; }
    stop() { this.playing = false; this.started = false; }
    update() {}
  }


  // =========================================================================
  // 6.7 DIVING AMBIENT AUDIO (أجواء الغوص — يعمل مغموراً فقط، مستوى حسب العمق + صدى 5%)
  // =========================================================================
  class DivingAmbientAudio {
    constructor() {
      this.audio = null; this.buffer = null; this.element = null;
      this.ready = false; this.failed = false;
      this.want = false;          // هل الكيان النشط مغمور؟
      this.started = false;
      this.elVol = 0.4;
      this.srcNode = null; this.gainNode = null;
    }

    // مستوى دائم 10% في كل الأعماق
    targetVol(d) {
  return 0.30;
}

    init(sharedAudioMgr) {
      if (this.ready || this.failed) { this.resume(); return; }
      this.mgr = sharedAudioMgr || null;
      this.audio = (this.mgr && this.mgr.ctx) ? this.mgr.ctx : (sharedAudioMgr && sharedAudioMgr.destination ? sharedAudioMgr : null);
      this.outNode = (this.mgr && this.mgr.ambientBus) ? this.mgr.ambientBus : null;
      if (!this.audio) {
        try {
          const AC = window.AudioContext || window.webkitAudioContext;
          this.audio = new AC();
        } catch (_) { this.audio = null; }
      }
      if (this.audio) {
        fetch('voices/divingsound.mp3')
          .then((r) => { if (!r.ok) throw new Error('nf'); return r.arrayBuffer(); })
          .then((ab) => this.audio.decodeAudioData(ab))
          .then((buf) => { this.buffer = buf; this.ready = true; })
          .catch(() => this._fallback());
      } else { this._fallback(); }
    }

    _fallback() {
      // تحميل وصفي خفيف لا يحجز مسار المعالجة الرئيسي لنظام أندرويد
      try {
        const el = new Audio();
        el.preload = 'metadata';
        el.src = 'voices/divingsound.mp3';
        el.loop = true;
        el.volume = 0.4;
        el.addEventListener('canplaythrough', () => { this.element = el; this.ready = true; }, { once: true });
        el.addEventListener('error', () => { this.failed = true; }, { once: true });
      } catch (_) { this.failed = true; }
    }

    resume() { if (this.audio && this.audio.state === 'suspended') this.audio.resume().catch(() => {}); }

    _play() {
      if (!this.want || this.started) return;
      if (this.buffer && this.audio) {
        try {
          this.srcNode = this.audio.createBufferSource();
          this.srcNode.buffer = this.buffer;
          this.srcNode.loop = true;
          this.gainNode = this.audio.createGain();
          this.gainNode.gain.value = 0.0001;
          const targetOut = this.outNode || this.audio.destination;
          this.srcNode.connect(this.gainNode);
          this.gainNode.connect(targetOut);

          // صدى خفيف جداً مع الاحتفاظ بالعقد لفصلها عند التوقف ومنع تسريب الذاكرة
          try {
            this.delayNode = this.audio.createDelay(1.0);
            this.delayNode.delayTime.value = 0.32;
            this.fbNode = this.audio.createGain(); this.fbNode.gain.value = 0.28;
            this.wetNode = this.audio.createGain(); this.wetNode.gain.value = 0.05;
            this.gainNode.connect(this.delayNode);
            this.delayNode.connect(this.fbNode); this.fbNode.connect(this.delayNode);
            this.delayNode.connect(this.wetNode); this.wetNode.connect(targetOut);
          } catch (_) {}

          this.srcNode.start();
          this.started = true;
          return;
        } catch (_) { this.srcNode = null; this.gainNode = null; }
      }
      if (this.element) {
        this.elVol = 0.0001;
        try { this.element.currentTime = 0; } catch (_) {}
        this.element.play().then(() => { this.started = true; }).catch(() => {});
      }
    }

    _stopPlayback() {
      this.started = false;
      if (this.srcNode) {
        try { this.srcNode.stop(); this.srcNode.disconnect(); } catch (_) {}
        this.srcNode = null;
      }
      if (this.gainNode) {
        try { this.gainNode.disconnect(); } catch (_) {}
        this.gainNode = null;
      }
      if (this.delayNode) { try { this.delayNode.disconnect(); } catch (_) {} this.delayNode = null; }
      if (this.fbNode) { try { this.fbNode.disconnect(); } catch (_) {} this.fbNode = null; }
      if (this.wetNode) { try { this.wetNode.disconnect(); } catch (_) {} this.wetNode = null; }
      if (this.element) {
        this.element.pause();
        try { this.element.currentTime = 0; } catch (_) {}
      }
    }

    update(dt, depthM, wantPlay) {
      this.want = wantPlay;
      if (this.want && !this.started && this.ready) this._play();
      if (!this.want && this.started) this._stopPlayback();
      if (!this.started) return;
      const target = this.targetVol(depthM);
      if (this.gainNode && this.audio) {
        this.gainNode.gain.setTargetAtTime(target, this.audio.currentTime, 0.3);
      } else if (this.element) {
        this.elVol += (target - this.elVol) * Math.min(1, 4 * dt);
        this.element.volume = Math.max(0.0001, this.elVol);
      }
    }
  }



  // =========================================================================
  // 6.7b RAIN AMBIENT AUDIO (صوت مطر مولّد — خفيف، يخفت تدريجيًا مع العمق)
  // =========================================================================
  class RainAmbientAudio {
    constructor() {
      this.ctx = null;
      this.mgr = null;
      this.ready = false;
      this.failed = false;
      this.playing = false;
      this.srcNode = null;
      this.gainNode = null;
      this.filterNode = null;
    }

    init(sharedAudioMgr) {
      if (this.ready || this.failed) return;
      this.mgr = sharedAudioMgr || null;
      this.ctx = (this.mgr && this.mgr.ctx) || null;
      if (!this.ctx) { this.failed = true; return; }
      try {
        // عازف ضوضاء مستمرة (مطر) — بلا ملفات ولا ضغط على الذاكرة
        const len = 2 * this.ctx.sampleRate;
        const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this.buffer = buf;
        this.ready = true;
      } catch (_) { this.failed = true; }
    }

    _start() {
      try {
        this.srcNode = this.ctx.createBufferSource();
        this.srcNode.buffer = this.buffer;
        this.srcNode.loop = true;
        this.filterNode = this.ctx.createBiquadFilter();
        this.filterNode.type = 'lowpass';
        this.filterNode.frequency.value = 1400;
        this.gainNode = this.ctx.createGain();
        this.gainNode.gain.value = 0.0001;
        this.srcNode.connect(this.filterNode);
        this.filterNode.connect(this.gainNode);
        this.gainNode.connect((this.mgr && this.mgr.ambientBus) || this.ctx.destination);
        this.srcNode.start();
        this.playing = true;
      } catch (_) { this.playing = false; }
    }

    _stop() {
      try { if (this.srcNode) this.srcNode.stop(); } catch (_) {}
      try { if (this.srcNode) this.srcNode.disconnect(); } catch (_) {}
      try { if (this.filterNode) this.filterNode.disconnect(); } catch (_) {}
      try { if (this.gainNode) this.gainNode.disconnect(); } catch (_) {}
      this.srcNode = null; this.filterNode = null; this.gainNode = null;
      this.playing = false;
    }

    // active: هل الجو عاصف؟ depthM: عمق الكيان — الصوت يخفت 0→1 كل 40م ويتوقف تمامًا
    update(active, depthM) {
      if (!this.ready) return;
      if (active && !this.playing) this._start();
      if (!active && this.playing) this._stop();
      if (!this.playing || !this.gainNode) return;
      const aboveFactor = depthM <= 0.5 ? 1 : Math.max(0, 1 - depthM / 40);
      const vol = 0.13 * aboveFactor; // مستوى خفيف دائمًا
      this.gainNode.gain.setTargetAtTime(Math.max(0.0001, vol), this.ctx.currentTime, 0.4);
    }
  }

  // =========================================================================
  // 6.8 OBJECT POOL (إعادة استخدام الجسيمات بدل إنشائها وحذفها كل إطار)
  // =========================================================================
  class ObjectPool {
    constructor(factory, capacity) {
      this.factory = factory;
      this.capacity = capacity;
      this.items = [];
    }
    obtain() {
      const items = this.items;
      for (let i = 0; i < items.length; i++) {
        if (!items[i].active) { items[i].active = true; return items[i]; }
      }
      if (items.length < this.capacity) {
        const o = this.factory();
        o.active = true;
        items.push(o);
        return o;
      }
      return null;
    }
    forEachActive(fn) {
      const items = this.items;
      for (let i = 0; i < items.length; i++) if (items[i].active) fn(items[i]);
    }
    release(o) { o.active = false; }
  }

  // تم حذف نظام الـChunks نهائياً — كان غير مفعّل لا يُنشأ في أي مكان؛ الزخارف الثابتة تُبنى مرة واحدة داخل TerrainSystem
  class Renderer {
    constructor(canvas, ctx, camera, terrain, ecology, optics) {

      this.canvas = canvas;
      this.ctx = ctx;
      this.camera = camera;
      this.terrain = terrain;
      this.ecology = ecology;
      this.optics = optics;
      this.stars = [];
      const sRng = new DeterministicRNG(445566);
      for (let i = 0; i < 70; i++) {
        this.stars.push({
          x: sRng.range(100, WORLD.WIDTH - 100),
          y: sRng.range(-280, WORLD.WATER_Y - 30),
          r: sRng.range(0.8, 1.8),
          p: sRng.range(0, Math.PI * 2),
          spd: sRng.range(1.5, 3.5)
        });
      }
    }

    render() {
      const cam = this.camera;
      const cw = this.canvas.width / (window.devicePixelRatio > 2.0 ? 2.0 : window.devicePixelRatio || 1);
      const ch = this.canvas.height / (window.devicePixelRatio > 2.0 ? 2.0 : window.devicePixelRatio || 1);

      // تحديث مسار قناع الماء الحركي وتدوير العوالق بنطاق الكاميرا
      // بناء مسار الماء مرة كل 30 إطاراً بدل كل إطار (حلقة ~3400 نقطة) — المسار مرجعي ولا يُقص به حالياً
      this._waterPathTick = (this._waterPathTick || 0) - 1;
      if (!this.waterPath || this._waterPathTick <= 0) {
        this.waterPath = this.buildWaterPath();
        this._waterPathTick = 30;
      }
      this.optics.recycleParticlesAround(cam.x, cam.y, cw / cam.zoom, ch / cam.zoom);

      const ctx = this.ctx;

      ctx.save();
      ctx.clearRect(0, 0, cw, ch);

      // مصفوفة التحويل للكاميرا مع الزوم
      ctx.translate(cw * 0.5, ch * 0.5);
      ctx.scale(cam.zoom, cam.zoom);
      ctx.translate(-cam.x, -cam.y);

      // إدارة Light Map Canvas للإضاءة السينمائية
      if (!this.lightCanvas) {
        this.lightCanvas = document.createElement('canvas');
        this.lightCtx = this.lightCanvas.getContext('2d', { alpha: false });
      }
      if (this.lightCanvas.width !== cw || this.lightCanvas.height !== ch) {
        this.lightCanvas.width = cw;
        this.lightCanvas.height = ch;
      }

      // --- طبقة 1: Base Albedo (الألوان الأصلية) ---
      this.drawSky(ctx);
      this.drawClouds(ctx);
      this.drawWaterColumn(ctx);
      this.drawRocks(ctx);
      this.drawMainTerrain(ctx);
      this.drawOrganisms(ctx);
      if (this.fauna) this.fauna.draw(ctx, this.camera);
      if (this.dock) this.dock.draw(ctx);
      if (this.shop) this.shop.draw(ctx);
      if (this.submarine) this.submarine.draw(ctx);
      if (this.fisherman) this.fisherman.draw(ctx, this.submarine);

      // --- طبقة 2: Light Map (الإضاءة الديناميكية والظلال) ---
      this.renderLightMap(this.lightCtx, cw, ch, cam);

      // تطبيق الـ Light Map (Multiply) ممتداً على كامل الشاشة (معالجة مشكلة الـ DPI)
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(this.lightCanvas, 0, 0, this.canvas.width, this.canvas.height);
      ctx.restore();

      // --- طبقة 3: Volumetrics & Effects (Additive) ---
      if (this.submarine) {
        this.submarine.drawAdditiveEffects(ctx, this.waterPath);
      }
      if (this.fisherman) {
        this.fisherman.drawAdditiveEffects(ctx);
      }
      this.drawMarineSnow(ctx);
      this.drawWaterSurface(ctx);
      this.drawStormRain(ctx);

      ctx.restore();
    }

    // مسار منطقة الماء (السطح + حدود التضاريس كاملة) — يُستخدم للقصّ: لا ضوء خلف الجدار أبداً
    buildWaterPath() {
      const path = new Path2D();
      const shoreX = WORLD.SHORE_X;
      path.moveTo(-100, this.optics.getWaterHeightAt(-100));
      for (let x = -100; x <= shoreX; x += 25) {
        path.lineTo(x, this.optics.getWaterHeightAt(x));
      }
      const pts = this.terrain.points;
      let shoreIdx = pts.length - 1;
      while (shoreIdx > 0 && pts[shoreIdx].x > shoreX) {
        shoreIdx--;
      }
      for (let i = shoreIdx; i >= 0; i--) {
        path.lineTo(pts[i].x, pts[i].y);
      }
      path.closePath();
      return path;
    }
    
    drawSky(ctx) {
      const dn = this.dayNight;
      const topCol = dn ? dn.skyTop : '#5fa8dc';
      const midCol = dn ? dn.skyMid : '#8ec8ea';
      const botCol = dn ? dn.skyBot : '#1e6694';

      const bgGrad = ctx.createLinearGradient(0, -300, 0, WORLD.WATER_Y + 500);
      bgGrad.addColorStop(0.0, topCol);
      bgGrad.addColorStop(0.8, midCol);
      bgGrad.addColorStop(1.0, botCol);
      
      ctx.fillStyle = bgGrad;
      ctx.fillRect(-100, -300, WORLD.WIDTH + 200, WORLD.HEIGHT + 500);

      // تعتيم السماء حسب الطقس (عاصفة أغمق، مغيم أخف)
      const wthr = this.dayNight ? this.dayNight.weather : 'sun';
      if (wthr === 'storm') {
        ctx.fillStyle = 'rgba(32, 38, 50, 0.42)';
        ctx.fillRect(-100, -300, WORLD.WIDTH + 200, WORLD.WATER_Y + 300);
      } else if (wthr === 'cloud' || wthr === 'snow') {
        ctx.fillStyle = 'rgba(70, 80, 95, 0.18)';
        ctx.fillRect(-100, -300, WORLD.WIDTH + 200, WORLD.WATER_Y + 300);
      }

      // رسم النجوم المتلألئة ليلاً
      if (dn && dn.starAlpha > 0.02) {
        ctx.save();
        const t = this.optics ? this.optics.time : 0;
        const starCount = Math.min(this.stars.length, Quality.q.stars);
        for (let si = 0; si < starCount; si++) {
          const s = this.stars[si];
          const tw = 0.75 + Math.sin(t * s.spd + s.p) * 0.25;
          ctx.fillStyle = `rgba(255, 255, 255, ${(dn.starAlpha * tw).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    drawClouds(ctx) {
      const wthr = this.dayNight ? this.dayNight.weather : 'sun';
      if (wthr === 'sun') return;
      const alpha = wthr === 'storm' ? 0.95 : (wthr === 'snow' ? 0.85 : 0.7);
      const fill = wthr === 'storm' ? '88, 95, 110' : '245, 248, 252';
      ctx.save();
      for (const cl of this.optics.clouds) {
        ctx.fillStyle = `rgba(${fill}, ${alpha})`;
        const s = cl.scale;
        ctx.beginPath();
        ctx.ellipse(cl.x, cl.y, 55 * s, 15 * s, 0, 0, Math.PI * 2);
        ctx.ellipse(cl.x - 30 * s, cl.y + 6 * s, 32 * s, 11 * s, 0, 0, Math.PI * 2);
        ctx.ellipse(cl.x + 32 * s, cl.y + 6 * s, 34 * s, 10 * s, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // مطر العاصفة أو تساقط الثلوج — فوق سطح الماء فقط، ويختفي تلقائيًا عند الغوص
    drawStormRain(ctx) {
      const wthr = this.dayNight ? this.dayNight.weather : 'sun';
      if (wthr !== 'storm' && wthr !== 'snow') return;
      const cam = this.camera;
      const dpr = window.devicePixelRatio > 2.0 ? 2.0 : window.devicePixelRatio || 1;
      const halfW = (this.canvas.width / dpr) / (2 * cam.zoom);
      const t = this.optics.time;
      ctx.save();
      if (wthr === 'storm') {
        ctx.strokeStyle = 'rgba(175, 200, 228, 0.38)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < Quality.q.rainDrops; i++) {
          const rx = cam.x - halfW + ((i * 137.5) % (halfW * 2));
          const speed = 520 + (i % 5) * 60;
          const ry = ((t * speed + i * 197) % 460) + WORLD.WATER_Y - 80;
          if (ry > WORLD.WATER_Y + 20) continue;
          ctx.moveTo(rx, ry);
          ctx.lineTo(rx - 4, ry + 16);
        }
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        for (let i = 0; i < Quality.q.flakes; i++) {
          const rx = cam.x - halfW + ((i * 173) % (halfW * 2));
          const speed = 40 + (i % 4) * 14;
          const ry = ((t * speed + i * 211) % 400) + WORLD.WATER_Y - 70;
          if (ry > WORLD.WATER_Y + 15) continue;
          ctx.beginPath();
          ctx.arc(rx, ry, 1.3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // خلفية التلال البعيدة أُلغيت — المشهد مقطع 2D نقي

    drawMainTerrain(ctx) {
      const pts = this.terrain.points;
      if (pts.length < 2) return;

      // 1. رسم جسم الأرض الصخرية والطبقات السفلية
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(WORLD.WIDTH + 100, WORLD.HEIGHT + 200);
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);

      for (let i = pts.length - 2; i >= 0; i--) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }

      ctx.lineTo(-100, pts[0].y);
      ctx.lineTo(-100, WORLD.HEIGHT + 200);
      ctx.closePath();

      // ألوان التضاريس الأساسية (Base Albedo) - الظلام يعالج عبر Light Map
      const terrainGrad = ctx.createLinearGradient(0, WORLD.WATER_Y - 100, 0, WORLD.HEIGHT);
      terrainGrad.addColorStop(0.0, '#d9b474');   // رمل ذهبي
      terrainGrad.addColorStop(0.005, '#a68550'); // رمل أغمق
      terrainGrad.addColorStop(0.02, '#5a4634');  // تربة
      terrainGrad.addColorStop(0.1, '#333b47');   // صخور رمادية
      terrainGrad.addColorStop(1.0, '#262d36');   // صخور سحيقة رمادية داكنة

      ctx.fillStyle = terrainGrad;
      ctx.fill();

      // 2. حافة تضاريس متناسقة (Base Albedo)
      const edgeGrad = ctx.createLinearGradient(0, WORLD.WATER_Y, 0, WORLD.HEIGHT);
      edgeGrad.addColorStop(0.0, '#caa868');   
      edgeGrad.addColorStop(0.01, '#9e8456'); 
      edgeGrad.addColorStop(0.03, '#584634'); 
      edgeGrad.addColorStop(0.1, '#454c59'); 
      edgeGrad.addColorStop(1.0, '#323a45');

      ctx.lineWidth = 1.8;
      ctx.strokeStyle = edgeGrad;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();

      // شقوق وعروق ماغما ثابتة تُرسم من مسارات مبنية مرة واحدة — نفس الشكل بلا حسابات كل إطار
      if (this.terrain.crackPaths) {
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.lineWidth = 2.2;
        ctx.stroke(this.terrain.crackPaths.basalt);
        ctx.strokeStyle = 'rgba(235, 60, 20, 0.72)';
        ctx.lineWidth = 2.6;
        ctx.stroke(this.terrain.crackPaths.magma);
      }
      ctx.restore();
    }

    drawRocks(ctx) {
      if (!this.terrain.rocks || this.terrain.rocks.length === 0) return;
      ctx.save();
      for (const rock of this.terrain.rocks) {
        ctx.save();
        ctx.translate(rock.x, rock.y);
        
        // ألوان صخرية بحرية داكنة (فحمي/رمادي مزرق) خالية تماماً من أي لون رملي
        const shade = rock.shade;
        let highestY = 0;
        for (const pt of rock.vertices) { if (pt.y < highestY) highestY = pt.y; }

        const grad = ctx.createLinearGradient(0, highestY, 0, 0);
        grad.addColorStop(0.0, `rgb(${35 * shade}, ${40 * shade}, ${45 * shade})`);
        grad.addColorStop(0.5, `rgb(${22 * shade}, ${26 * shade}, ${32 * shade})`);
        grad.addColorStop(1.0, `rgb(${10 * shade}, ${12 * shade}, ${16 * shade})`);
        
        ctx.fillStyle = grad;
        ctx.strokeStyle = `rgb(${15 * shade}, ${18 * shade}, ${22 * shade})`;
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';

        ctx.beginPath();
        ctx.moveTo(rock.vertices[0].x, rock.vertices[0].y);
        for (let i = 1; i < rock.vertices.length; i++) {
          ctx.lineTo(rock.vertices[i].x, rock.vertices[i].y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // تفاصيل شقوق بسيطة جداً وغير مبالغ فيها
        ctx.strokeStyle = `rgba(5, 7, 10, 0.5)`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(rock.vertices[1].x, rock.vertices[1].y);
        ctx.lineTo(rock.vertices[1].x * 0.3, rock.vertices[1].y * 0.5);
        if (rock.vertices.length > 4) {
          ctx.moveTo(rock.vertices[3].x, rock.vertices[3].y);
          ctx.lineTo(rock.vertices[3].x * 0.4, rock.vertices[3].y * 0.6);
        }
        ctx.stroke();

        ctx.restore();
      }
      ctx.restore();
    }

    drawOrganisms(ctx) {
      const orgs = this.ecology.organisms;
      const t = this.optics.time;
      const cam = this.camera;
      const dprN = window.devicePixelRatio > 2.0 ? 2.0 : window.devicePixelRatio || 1;
      const orgHalfW = ((this.canvas.width / dprN) / cam.zoom) * 0.5 + 100;

      for (const org of orgs) {
        if (Math.abs(org.x - cam.x) > orgHalfW) continue;
        if (org.type === 'seagrass') {
          const sway = Math.sin(t * org.speed + org.phase) * 10;
          ctx.save();

          // تثبيت كل ورقة عشب بدقة على خط ارتفاع الأرض الفعلي لمنع الطفو أو الانغراس
          for (let b = 0; b < org.bladeCount; b++) {
            const spread = (b - org.bladeCount * 0.5) * 3.2;
            const bx = org.x + spread;
            const by = this.terrain.getHeightAt(bx); // الالتصاق التام بالأرض
            const bladeH = org.height * (0.85 + (b % 3) * 0.1);
            const bSway = sway * (0.7 + (b / org.bladeCount) * 0.5);

            ctx.fillStyle = `hsla(${org.hue + (b % 2) * 5}, 54%, ${26 + (b % 3) * 4}%, 0.92)`;
            ctx.beginPath();
            ctx.moveTo(bx - 1.2, by);
            ctx.quadraticCurveTo(bx + bSway * 0.3, by - bladeH * 0.5, bx + bSway, by - bladeH);
            ctx.quadraticCurveTo(bx + bSway * 0.4 + 1.0, by - bladeH * 0.45, bx + 1.2, by);
            ctx.closePath();
            ctx.fill();
          }
          ctx.restore();
        } else if (org.type === 'crustose_algae') {
          // طحالب قشرية ملتصقة بالقاع: بقع مسطحة منخفضة ملونة
          ctx.save();
          ctx.translate(org.x, this.terrain.getHeightAt(org.x));
          ctx.fillStyle = `hsla(${org.hue}, 55%, 32%, 0.9)`;
          for (let i = 0; i < 3; i++) {
            const ox = (i - 1) * 7 + Math.sin(org.phase + i) * 3;
            ctx.beginPath();
            ctx.ellipse(ox, -1.5, 6 - i, 2.4, 0, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        } else if (org.type === 'shallow_green_algae' || org.type === 'brown_macroalgae' || org.type === 'red_algae') {
          const sway = Math.sin(t * org.speed + org.phase) * 7;
          ctx.save();
          ctx.translate(org.x, org.y);
          ctx.strokeStyle = `hsla(${org.hue}, 52%, 26%, 0.95)`;
          ctx.fillStyle = `hsla(${org.hue}, 48%, 32%, 0.88)`;
          ctx.lineWidth = (org.type === 'red_algae') ? 1.4 : 2.0;

          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.quadraticCurveTo(sway * 0.4, -org.height * 0.5, sway, -org.height);
          ctx.stroke();

          const branches = org.branchCount || 3;
          for (let i = 1; i <= branches; i++) {
            const frac = i / (branches + 1);
            const lx = sway * frac;
            const ly = -org.height * frac;
            const side = (i % 2 === 0) ? 1 : -1;
            ctx.beginPath();
            ctx.ellipse(lx + side * 7, ly, 6.5, 3.2, (side * 28 * Math.PI) / 180, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }
      }
    }

    drawWaterColumn(ctx) {
      // ألوان الماء الأساسية (Base Albedo) - الإظلام يتم عبر Light Map
      ctx.save();
      const waterGrad = ctx.createLinearGradient(0, WORLD.WATER_Y, 0, WORLD.HEIGHT);
      waterGrad.addColorStop(0.0, 'rgba(40, 160, 200, 0.4)');
      waterGrad.addColorStop(0.05, 'rgba(25, 120, 170, 0.6)');
      waterGrad.addColorStop(1.0, 'rgba(10, 70, 120, 0.95)');

      ctx.fillStyle = waterGrad;
      ctx.beginPath();

      // 1. تتبع سطح الماء من أقصى اليسار حتى الشاطئ
      const shoreX = WORLD.SHORE_X;
      ctx.moveTo(-100, this.optics.getWaterHeightAt(-100));
      for (let x = -100; x <= shoreX; x += 25) {
        ctx.lineTo(x, this.optics.getWaterHeightAt(x));
      }

      // 2. تتبع نقاط القاع والجدار الصخري نفسها رجوعاً حتى قاع السحيق (منع الفجوات الزرقاء)
      const pts = this.terrain.points;
      let shoreIdx = pts.length - 1;
      while (shoreIdx > 0 && pts[shoreIdx].x > shoreX) {
        shoreIdx--;
      }

      for (let i = shoreIdx; i >= 0; i--) {
        ctx.lineTo(pts[i].x, pts[i].y);
      }

      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // تأثيرات الضوء القديمة أُلغيت — الإضاءة الحالية عبر Light Map فقط

    drawWaterSurface(ctx) {
      ctx.save();
      ctx.beginPath();

      const startX = -50;
      const endX = WORLD.SHORE_X + 40;
      ctx.moveTo(startX, this.optics.getWaterHeightAt(startX));

      for (let x = startX + 10; x <= endX; x += 12) {
        ctx.lineTo(x, this.optics.getWaterHeightAt(x));
      }

      // خط لمعان سطح البحر متعدد الطبقات: توهج ناعم عريض + نواة ساطعة
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.lineWidth = 6.5;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.68)';
      ctx.lineWidth = 2.2;
      ctx.stroke();

      // بريق سطحي متحرك خفيف — يظهر على جودتي high وmax فقط
      if (Quality.q.surfaceSparkle) {
        const t = this.optics.time;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
        for (let i = 0; i < 14; i++) {
          const sx = startX + ((i * 977) % (endX - startX));
          ctx.globalAlpha = 0.28 * (0.4 + 0.6 * Math.abs(Math.sin(t * 1.6 + i * 1.7)));
          ctx.beginPath();
          ctx.arc(sx, this.optics.getWaterHeightAt(sx) - 1.5, 1.1, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();
    }

    drawMarineSnow(ctx) {
      ctx.save();
      const cam = this.camera;
      const halfW = (this.canvas.width / (cam.zoom * 2)) * 1.08;
      const halfH = (this.canvas.height / (cam.zoom * 2)) * 1.08;

      const snowCount = Math.min(this.optics.particles.length, Quality.q.snow);
      for (let pi = 0; pi < snowCount; pi++) {
        const p = this.optics.particles[pi];
        if (Math.abs(p.x - cam.x) > halfW || Math.abs(p.y - cam.y) > halfH) continue;
        // حظر رسم العوالق خارج الماء نهائياً (ممنوع في السماء أو على اليابسة)
        if (p.x >= WORLD.SHORE_X - 10) continue;
        const wY = this.optics.getWaterHeightAt(p.x);
        if (p.y <= wY + 3 || p.y >= this.terrain.getHeightAt(p.x) - 4) continue;

        const depthM = Math.max(0, (p.y - WORLD.WATER_Y) / WORLD.PIXELS_PER_METER);
        const depthFactor = Math.max(0.02, 1.0 - Math.min(1.0, depthM / 95));
        const lifeFactor = p.maxLife ? Math.sin((p.life / p.maxLife) * Math.PI) : 1;
        const finalAlpha = p.alpha * depthFactor * lifeFactor;

        if (finalAlpha > 0.015) {
          ctx.fillStyle = `rgba(215, 240, 255, ${finalAlpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    renderLightMap(lCtx, cw, ch, cam) {
      lCtx.save();
      lCtx.fillStyle = '#000000';
      lCtx.fillRect(0, 0, cw, ch);

      lCtx.translate(cw * 0.5, ch * 0.5);
      lCtx.scale(cam.zoom, cam.zoom);
      lCtx.translate(-cam.x, -cam.y);

      // 1. Ambient Sunlight متناغم مع دورة الليل والنهار
      const dn = this.dayNight;
      const topAmb = dn ? dn.ambientTop : '#ffffff';
      const midAmb = dn ? dn.ambientMid : '#aaccff';

      const sunGrad = lCtx.createLinearGradient(0, WORLD.WATER_Y - 200, 0, WORLD.WATER_Y + 6000);
      sunGrad.addColorStop(0.0, topAmb); 
      sunGrad.addColorStop(0.05, midAmb); 
      sunGrad.addColorStop(0.25, '#1a3b5c'); 
      sunGrad.addColorStop(1.0, '#0a0f16'); // Ambient Floor
      
      lCtx.fillStyle = sunGrad;
      lCtx.fillRect(cam.x - (cw/cam.zoom)*3, WORLD.WATER_Y - 500, (cw/cam.zoom)*6, WORLD.HEIGHT);

      // إضاءة فانوس المتجر الخشبي ليلاً
      if (this.shop) {
        lCtx.save();
        lCtx.globalCompositeOperation = 'screen';
        this.shop.drawLight(lCtx);
        lCtx.restore();
      }

      // توهج الكائنات البحرية ذات الإضاءة الحيوية في ظلمات الأعماق
      if (this.fauna && this.fauna.drawLight) {
        lCtx.save();
        lCtx.globalCompositeOperation = 'screen';
        this.fauna.drawLight(lCtx);
        lCtx.restore();
      }

      // 2. Dynamic Searchlights (رسم كشاف الغواصة وكشاف الغواص على الـ Light Map)
      if (this.submarine) {
        lCtx.globalCompositeOperation = 'screen';
        this.submarine.drawSearchlightIllumination(lCtx, this.terrain, this.waterPath);
      }

      if (this.fisherman && !this.fisherman.inSubmarine && this.fisherman.lightOn) {
        lCtx.globalCompositeOperation = 'screen';
        this.fisherman.drawSearchlightIllumination(lCtx, this.terrain, this.submarine);
      }

      lCtx.restore();
    }

    // تم إزالة دالة drawCaustics لتنظيف المشهد البصري للرمل
  }

  // =========================================================================
  // 8. GAME ENGINE CORE & LIFECYCLE
  // =========================================================================
  class Engine {
    constructor() {
      this.canvas = document.getElementById('gameCanvas');
      this.ctx = this.canvas.getContext('2d', { alpha: false });

      this.camera = new Camera2D();
      this.dayNight = new DayNightSystem();
      this.terrain = new TerrainSystem();
      this.ecology = new EcologySystem(this.terrain);
      this.fauna = new MarineFaunaSystem(this.terrain);
      this.optics = new OpticsSystem();
      this.dock = new WoodenDock(this.terrain);
      this.shop = new WoodenShop(this.dock);
      this.fisherman = new Fisherman(this.terrain, this.dock);
      this.submarine = new Submarine(this.terrain);

      // قفل الكاميرا على الصياد عند بداية التشغيل
      this.camera.followEntity = this.fisherman;

      this.audioManager = new AudioManager();
      this.submarineEngine = new SubmarineEngineSound(this.audioManager);
      this.submarine.engineAudio = this.submarineEngine;

      this.whaleAudio = new WhaleCallSystem();
      this.ringAudio = new SubmarineRingAudio();
      this.submarine.ringAudio = this.ringAudio;
      this.diveAudio = new DivingAmbientAudio();
      this.rainAudio = new RainAmbientAudio();

      this.input = new InputEngine(this.canvas, this.camera);
      this.renderer = new Renderer(this.canvas, this.ctx, this.camera, this.terrain, this.ecology, this.optics);
      this.renderer.dayNight = this.dayNight;
      this.renderer.fauna = this.fauna;
      this.renderer.dock = this.dock;
      this.renderer.shop = this.shop;
      this.renderer.fisherman = this.fisherman;
      this.renderer.submarine = this.submarine;

      this.btnAction = document.getElementById('btn-action');
      // عناصر واجهة قديمة غير موجودة — التفاعل والضوء من زر واحد موحد
      this.btnJump = document.getElementById('btn-jump');

      // عناصر الواجهة
      this.depthGauge = document.getElementById('depth-gauge');
      this.zoneGauge = document.getElementById('zone-gauge');
      this.timeGauge = document.getElementById('time-gauge');
      // عناصر واجهة الضغط والهيكل ومشهد الموت
      this.subSystemsHud = document.getElementById('sub-systems-hud');
      this.subWarnBanner = document.getElementById('sub-warning-banner');
      this.gaugeNeedle = document.getElementById('gauge-needle');
      this.pressureVal = document.getElementById('pressure-val');
      this.hullDamageFill = document.getElementById('hull-damage-fill');
      this.hullHpText = document.getElementById('hull-hp-text');
      this.damageVignette = document.getElementById('damage-vignette');
      this.revivalModal = document.getElementById('revival-modal');
      this.btnRevival = document.getElementById('btn-revival');

      this.timeScale = 1.0;
      this.deathEffectTimer = 0;
      this.isMapOpen = false;
      this.mapCanvas = document.getElementById('mapCanvas');
      this.mapCtx = this.mapCanvas ? this.mapCanvas.getContext('2d') : null;
      this.mapCam = {
        panX: 0,
        panY: 0,
        zoom: 1.0,
        isDrag: false,
        lastX: 0,
        lastY: 0,
        initDist: 0,
        initZoom: 1.0
      };
      // كاش نقاط الخريطة غير مستخدم — الرادار يرسم إطاراً سلكياً مباشرة

      this.lastTime = 0;
      this.running = false;
      this.fixedStep = 1 / 60;
      this.accumulator = 0;

      this._joyLastActive = performance.now();
      this.initWindowEvents();
      this.initUI();
      this.handleResize();
    }

    initWindowEvents() {
      // فك قفل الصوت فورياً في مرحلة الـ Capture لأول لمسة (حتى مع عصا التحكم)
      const unlockAudio = () => {
        try {
          if (document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(() => {});
          }
          if (screen.orientation && screen.orientation.lock) {
            screen.orientation.lock('landscape').catch(() => {});
          }
        } catch (_) {}

        if (this.audioManager && !this.audioManager.unlocked) {
          this.audioManager.unlock();
          // تحميل الملفات بالتتابع في الخلفية لمنع أي تجميد للإطارات
          setTimeout(() => {
            if (this.diveAudio) this.diveAudio.init(this.audioManager);
          }, 350);
          setTimeout(() => {
            if (this.rainAudio) this.rainAudio.init(this.audioManager);
          }, 600);
          setTimeout(() => {
            if (this.whaleAudio) this.whaleAudio.initAudio(this.audioManager);
          }, 1500);
        }
      };

      window.addEventListener('pointerdown', unlockAudio, { capture: true, once: true });
      window.addEventListener('touchstart', unlockAudio, { capture: true, once: true });

      window.addEventListener('resize', () => this.handleResize(), { passive: true });
      window.addEventListener('orientationchange', () => {
        setTimeout(() => this.handleResize(), 200);
      });

      // إيقاف الصوت وحفظ التوقيت عند الخروج للـ Background واستئنافهما فورياً
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.accumulator = 0;
          this.lastTime = performance.now();
          if (this.dayNight) this.dayNight.saveTime();
          this.audioManager.suspend();
        } else {
          this.lastTime = performance.now();
          this.audioManager.resume();
        }
      });
      window.addEventListener('beforeunload', () => {
        if (this.dayNight) this.dayNight.saveTime();
      });
    }

    initUI() {
      // زر تجربة صوت الحوت (تشغيل فوري بتجاوز المؤقت — للاختبار)
      // زر تجربة صوت الحوت غير موجود في الواجهة — testCall يبقى متاحاً للاستخدام المستقبلي

      // زر تسريع الوقت غير موجود في الواجهة الحالية — أُلغي معالجه

      // أزرار وخريطة الرادار التفاعلية
      const btnMapToggle = document.getElementById('btn-map-toggle');
      const btnMapClose = document.getElementById('btn-map-close');
      const btnZoomIn = document.getElementById('btn-radar-zoom-in');
      const btnZoomOut = document.getElementById('btn-radar-zoom-out');
      const btnReset = document.getElementById('btn-radar-reset');
      const mapModal = document.getElementById('map-modal');

      if (btnZoomIn) {
        btnZoomIn.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.mapCam.zoom = Math.min(4.5, this.mapCam.zoom * 1.35);
        });
      }
      if (btnZoomOut) {
        btnZoomOut.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.mapCam.zoom = Math.max(0.85, this.mapCam.zoom / 1.35);
        });
      }
      if (btnReset) {
        btnReset.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.mapCam.zoom = 1.0;
          this.mapCam.panX = 0;
          this.mapCam.panY = 0;
        });
      }

      if (btnMapToggle && mapModal) {
        btnMapToggle.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.isMapOpen = true;
          mapModal.classList.remove('hidden');
          this.renderMinimap();
        });
      }

      this.initRadarTouchPan();
      if (btnMapClose && mapModal) {
        const closeMap = (e) => {
          if (e) e.stopPropagation();
          this.isMapOpen = false;
          mapModal.classList.add('hidden');
        };
        btnMapClose.addEventListener('pointerdown', closeMap);
        btnMapClose.addEventListener('click', closeMap);
        mapModal.addEventListener('pointerdown', (e) => {
          if (e.target === mapModal) closeMap(e);
        });
      }

      // زر الكشاف السيبراني المتجاوب والموحد
      const btnLightToggle = document.getElementById('btn-light-toggle');
      if (btnLightToggle) {
        btnLightToggle.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          const inSub = this.submarine && this.submarine.occupied;
          if (inSub) {
            this.submarine.lightsOn = !this.submarine.lightsOn;
          } else if (this.fisherman) {
            this.fisherman.lightOn = !this.fisherman.lightOn;
          }
          const isOff = inSub ? !this.submarine.lightsOn : !this.fisherman.lightOn;
          btnLightToggle.classList.toggle('is-off', isOff);
        });
      }

      // حدث زر الإنعاش وإصلاح الغواصة
      if (this.btnRevival) {
        const handleRevive = (e) => {
          if (e) e.stopPropagation();
          // إعادة إحياء داخل الغواصة عند عمق 20م (520px) بجانب الصخور في المياه المفتوحة (8600px)
          const respawnX = 8500;
          const respawnY = WORLD.WATER_Y + 100; // نفس نقطة البداية الآمنة غرب الصخور

          if (this.submarine) {
            this.submarine.health = 100;
            this.submarine.isCrushed = false;
            this.submarine.crushAnim = 0;
            this.submarine.crushTimer = 0;
            this.submarine.bloodPlume = [];
            this.submarine.cracks = [];
            this.submarine.lightsOn = true;
            this.submarine.occupied = true;
            this.submarine.x = respawnX;
            this.submarine.y = respawnY;
            this.submarine.vx = 0;
            this.submarine.vy = 0;
          }
          if (this.fisherman) {
            this.fisherman.inSubmarine = true;
            this.fisherman.health = 100;
            this.fisherman.oxygen = 100;
            this.fisherman.isDead = false;
            this.fisherman.crushed = false;
            this.fisherman.deathTimer = 0;
            this.fisherman.bloodBurst = [];
            this.fisherman.droppedLight = null;
            this.fisherman.x = respawnX;
            this.fisherman.y = respawnY;
          }
          if (this.camera) {
            this.camera.followEntity = this.submarine;
            this.camera.x = respawnX;
            this.camera.y = respawnY;
          }
          this.timeScale = 1.0;
          document.body.classList.remove('gta-death');
          if (this.revivalModal) this.revivalModal.classList.add('hidden');
        };
        this.btnRevival.addEventListener('pointerdown', handleRevive);
        this.btnRevival.addEventListener('click', handleRevive);
      }

      // حدث ركوب ونزول الغواصة
      if (this.btnAction) {
        this.btnAction.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.submarine.occupied) {
            // النزول من الغواصة وإعادة عتلة السرعة إلى IDLE
            this.submarine.occupied = false;
            if (this.input.throttle) this.input.throttle.setLevel(0);
            this.fisherman.inSubmarine = false;
            this.fisherman.x = this.submarine.x;
            this.fisherman.y = this.submarine.y - 15;
            this.camera.followEntity = this.fisherman;
            this.ringAudio.stop();
          } else {
            // الركوب داخل الغواصة وتجهيز السرعة
            if (this.audioManager && !this.audioManager.unlocked) {
              this.audioManager.unlock();
            }
            this.submarine.occupied = true;
            if (this.input.throttle) this.input.throttle.setLevel(0);
            this.fisherman.inSubmarine = true;
            this.camera.followEntity = this.submarine;
            this.ringAudio.start();
          }
        });
      }

      // تم استبداله: حذف معالج حدث زر إعادة ضبط الكاميرا
      // تم استبداله: حذف مستمعات زر ونافذة معلومات البيئة
    }

    handleResize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2.0); // سقف أمان للدقة لمنع إجهاد الذاكرة
      const w = window.innerWidth;
      const h = window.innerHeight;

      this.canvas.width = Math.floor(w * dpr);
      this.canvas.height = Math.floor(h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      this.camera.resize(w, h);
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.lastTime = performance.now();
      requestAnimationFrame((t) => this.loop(t));
    }

    loop(currentTime) {
      if (!this.running) return;

      let dt = (currentTime - this.lastTime) / 1000;
      this.lastTime = currentTime;

      // مشهد الموت مع انتظار 3 ثوانٍ وظهور زر إعادة الإحياء النقي
      const subDead = this.submarine && this.submarine.isCrushed && this.submarine.crushTimer >= 3.0;
      const diverDead = this.fisherman && this.fisherman.isDead && this.fisherman.deathTimer >= 3.0;

      if ((subDead || diverDead) && this.revivalModal) {
        this.revivalModal.classList.remove('hidden');
      } else if (this.revivalModal) {
        this.revivalModal.classList.add('hidden');
      }
      if (dt > 0.1) dt = 0.1;
      this.accumulator += dt;

      while (this.accumulator >= this.fixedStep) {
        this.update(this.fixedStep);
        this.accumulator -= this.fixedStep;
      }

      this.renderer.render();
      this.updateHUD();

      requestAnimationFrame((t) => this.loop(t));
    }

    update(dt) {
      // إخفاء العتلة والبانر بشكل قاطع إذا لم يكن اللاعب داخل الغواصة
      const inSub = !!(this.submarine && this.submarine.occupied);
      if (!this._subPanelEl) this._subPanelEl = document.getElementById('sub-throttle');
      const subPanel = this._subPanelEl;
      if (subPanel) subPanel.classList.toggle('hidden', !inSub);
      if (!inSub && this.subWarnBanner) {
        this.subWarnBanner.textContent = '';
        this.subWarnBanner.classList.add('hidden');
      }

      // تحديث الخريطة الحية وتجميد الحركة أثناء فتحها
      if (this.isMapOpen) {
        if (this.submarine) {
          this.submarine.vx = 0;
          this.submarine.vy = 0;
          this.submarine.thrustSpeed = 0;
        }
        this.renderMinimap();
        return;
      }

      const joy = this.input.joystick;
      const throttleLvl = this.input.subThrottleLevel || 0;

      // تحديث حركة الصياد بالغواصة وعصا التوجيه وعتلة السرعة
      const jumpReq = this.input.jumpRequested;
      if (this.shop) this.shop.update(dt);
      this.fisherman.update(dt, joy, this.submarine, jumpReq);
      this.submarine.update(dt, joy, throttleLvl);

      // منطق تفاعل الركوب والنزول من الغواصة
      const distToSub = Math.hypot(this.fisherman.x - this.submarine.x, this.fisherman.y - this.submarine.y);

      // تم استبداله: التحقق المكرر من عتلة السرعة

      // أزرار كشاف منفصلة غير موجودة في الواجهة — الضوء يُدار من زر موحد (btn-light-toggle)

      // إخفاء أزرار التحكم غير المتوافقة مع حالة الركوب
      if (this.btnJump) {
        const hideJump = inSub || (this.fisherman && this.fisherman.mode === 'dive');
        this.btnJump.classList.toggle('hidden', hideJump);
      }

      // ضبط ظهور زر التفاعل بدقة: يختفي كلياً إذا كان بعيداً
      if (this.btnAction) {
        if (!this._actionWrapEl) this._actionWrapEl = document.getElementById('action-icon-wrap');
        const wrap = this._actionWrapEl;
        if (inSub) {
          this.btnAction.classList.remove('hidden');
          this.btnAction.classList.add('compact-exit');
          if (wrap && this._actionState !== 'exit') {
            this._actionState = 'exit';
            wrap.innerHTML = '<img class="action-ico-img" src="voices/interaction.webp" alt="">';
          }
        } else {
          const canBoard = distToSub < 95;
          this.btnAction.classList.remove('compact-exit');
          this.btnAction.classList.toggle('hidden', !canBoard);
          if (canBoard && wrap && this._actionState !== 'enter') {
            this._actionState = 'enter';
            wrap.innerHTML = '<img class="action-ico-img" src="voices/interaction.webp" alt="">';
          }
        }
      }

      this.input.update(dt);

      // خمول عصا التحكم: تتلاشى تدريجيًا بعد 5 ثوانٍ دون لمس وتعود عند أول لمسة
      if (!this._joyZoneEl) this._joyZoneEl = document.getElementById('joystick-zone');
      const jZone = this._joyZoneEl;
      if (jZone) {
        const jState = this.input.joystick;
        if (jState && (jState.active || jState.force > 0.05)) {
          this._joyLastActive = performance.now();
        }
        jZone.classList.toggle('is-idle', performance.now() - this._joyLastActive > 5000);
      }

      this.camera.update(dt);
      this.optics.update(dt);
      if (this.dayNight) this.dayNight.update(dt);
      if (this.fauna) this.fauna.update(dt, this.camera, this.submarine, this.fisherman);

      // تحديث محرك صوت الغواصة بالسرعة والحالة دون إنشاء أي عقد جديدة
      const subSpeed = Math.hypot(this.submarine.vx, this.submarine.vy);
      this.submarineEngine.update(subSpeed, this.submarine.occupied);

      // صوت الحوت والبيئة
      const act = this.submarine.occupied ? this.submarine : this.fisherman;
      const off = this.submarine.occupied ? 0 : 12;
      const depthM = Math.max(0, (act.y - (WORLD.WATER_Y + off)) / WORLD.PIXELS_PER_METER);
      this.whaleAudio.update(dt, depthM);
      this.ringAudio.update();

      const submerged = depthM > 2;
      this.diveAudio.update(dt, depthM, submerged);
      // صوت المطر الخفيف: ينخفض تدريجيًا مع الغوص ويتوقف في الأعماق
      if (this.rainAudio) {
        this.rainAudio.update(this.dayNight && this.dayNight.weather === 'storm', depthM);
      }
    }

    _hudText(el, val) { if (el && el.__v !== val) { el.__v = val; el.textContent = val; } }
    _hudWidth(el, val) { if (el && el.__w !== val) { el.__w = val; el.style.width = val; } }

    updateHUD() {
      const active = this.submarine.occupied ? this.submarine : this.fisherman;
      const camX = active ? active.x : this.camera.x;
      // قياس عمق الكيان النشط الحقيقي من خط الماء (0.0م عند السطح بدقة)
      const offset = this.submarine.occupied ? 0 : 12;
      const depthPx = active ? Math.max(0, active.y - (WORLD.WATER_Y + offset)) : Math.max(0, this.camera.y - WORLD.WATER_Y);
      const depthMeters = depthPx / WORLD.PIXELS_PER_METER;

      if (this.depthGauge) {
        if (depthMeters <= 0) {
          this._hudText(this.depthGauge, 'السطح (0.0 م)');
        } else if (depthMeters >= 1000) {
          this._hudText(this.depthGauge, `${(depthMeters / 1000).toFixed(2)} كم (${Math.round(depthMeters)} م)`);
        } else {
          this._hudText(this.depthGauge, `${depthMeters.toFixed(1)} م`);
        }
      }

      if (this.zoneGauge) {
        let zone = 'الشاطئ والكثبان الرملية';
        if (depthMeters <= 0.5 && camX < WORLD.SHORE_X - 20) {
          zone = 'منطقة المد والجزر (Intertidal)';
        } else if (depthMeters > 0.5 && depthMeters <= 5.0) {
          zone = 'المياه الضحلة الرملية (Shallow Sand)';
        } else if (depthMeters > 5.0 && depthMeters <= 30.0) {
          zone = 'المنحدر الطميي والتربة البحرية (Sediment Slope)';
        } else if (depthMeters > 30.0 && depthMeters < 100.0) {
          zone = 'المنحدر الانتقالي الصخري (Rocky Transition)';
        } else if (depthMeters >= 100.0 && depthMeters < 5000.0) {
          zone = 'الجدار الصخري السحيق (Bathyal Cliff)';
        } else if (depthMeters >= 5000.0 && depthMeters < 7000.0) {
          zone = 'الأعماق البازلتية السوداء (Abyssal Basalt)';
        } else if (depthMeters >= 7000.0 && depthMeters < 9000.0) {
          zone = 'الشقوق البركانية والماغما (Magma Fissures)';
        } else if (depthMeters >= 9000.0) {
          zone = 'خندق ماريانا تشالنجر ديب (Challenger Deep)';
        }
        this._hudText(this.zoneGauge, zone);
      }

      const inSub = this.submarine && this.submarine.occupied;
      const act = inSub ? this.submarine : this.fisherman;
      const dM = Math.round(Math.max(0, (act.y - WORLD.WATER_Y) / WORLD.PIXELS_PER_METER));

      // 1. تحديث شريط البيئة والوقت
      if (this.timeGauge && this.dayNight) this._hudText(this.timeGauge, this.dayNight.getTimeString());

      // أيقونة الطقس حسب الجو والليل
      if (this.dayNight) {
        const w = this.dayNight.weather;
        const isNight = this.dayNight.starAlpha > 0.4;
        const wIcon = document.getElementById('weather-icon');
        if (wIcon) {
          let src = 'voices/day.webp';
          if (isNight) src = 'voices/night.webp';
          else if (w === 'storm') src = 'voices/storm.webp';
          else if (w === 'snow') src = 'voices/snow.webp';
          else if (w === 'cloud') src = 'voices/cloudy.webp';
          if (this._lastWeatherIcon !== src) {
            this._lastWeatherIcon = src;
            wIcon.src = src;
            wIcon.style.opacity = '1';
          }
        }
        // الحرارة المحيطة: حسب الجو والليل، وتنخفض مع العمق حتى 2°
        const tempEl = document.getElementById('temp-gauge');
        if (tempEl) {
          let temp = w === 'sun' ? 24 : (w === 'cloud' ? 17 : (w === 'storm' ? 13 : -2));
          if (isNight) temp -= 6;
          if (dM > 0) temp = Math.round(Math.max(2, temp - dM * 0.35));
          this._hudText(tempEl, `${temp}°`);
        }
      }
      this._hudText(this.depthGauge, `- ${dM} m`);

      // 2. تبديل صورة الأفاتار الدائري من مجلد voices/
      const avatarImg = document.getElementById('hud-avatar-img');
      if (avatarImg) {
        const targetSrc = inSub ? 'voices/SubmarineCircle.png' : 'voices/PlayerCircle.png';
        if (this._lastAvatarSrc !== targetSrc) {
          this._lastAvatarSrc = targetSrc;
          avatarImg.src = targetSrc;
          avatarImg.style.opacity = '1';
        }
      }

      // تحديث حيوية الغواص والضغط المدمج (أعلى اليسار)
      const hpBar = document.getElementById('bar-player-hp');
      const oxyBar = document.getElementById('bar-oxygen');
      const hpTxt = document.getElementById('hp-val-text');
      const oxyTxt = document.getElementById('oxy-val-text');
      const pressBar = document.getElementById('bar-vital-pressure');
      const pressTxt = document.getElementById('press-val-text');

      // تبديل الصحة تلقائياً: صحة الغواصة عند الركوب وصحة اللاعب عند النزول
      const curHp = inSub
        ? Math.round(Math.max(0, this.submarine ? this.submarine.health : 100))
        : Math.round(Math.max(0, this.fisherman ? this.fisherman.health : 100));
      const curOxy = Math.round(Math.max(0, this.fisherman ? this.fisherman.oxygen : 100));

      // تبديل أيقونة القلب: غواصة داخل الغواصة / قلب خارجها
      const hpIconSub = document.getElementById('hp-icon-sub');
      const hpIconDiver = document.getElementById('hp-icon-diver');
      if (hpIconSub && hpIconDiver) {
        hpIconSub.style.display = inSub ? 'block' : 'none';
        hpIconDiver.style.display = inSub ? 'none' : 'block';
      }
      // شارة zzz فوق أيقونة الأكسجين داخل الغواصة (لا استهلاك)
      const oxyWrap = document.getElementById('oxy-icon-wrap');
      if (oxyWrap) oxyWrap.classList.toggle('is-idle', inSub);
      // الوزن: يقيس وزن الحقيبة فقط — فارغة افتراضيًا
      const weightTxt = document.getElementById('weight-val-text');
      if (weightTxt) weightTxt.textContent = '0';

      this._hudWidth(hpBar, `${curHp}%`);
      this._hudWidth(oxyBar, `${curOxy}%`);
      this._hudText(hpTxt, `${curHp}/100`);
      this._hudText(oxyTxt, `${curOxy}/100`);

      // حساب وتحديث شريط وقيمة الضغط المدمج
            const barsVal = (1.0 + dM / 10).toFixed(1);
      this._hudText(pressTxt, `${barsVal}`);
      if (pressBar) {
        // إذا لم تكن this.maxSafeDepth معرفة مسبقاً، سنعطيها قيمة افتراضية كـ 500 لحماية اللعبة من الانهيار
        const safeDepth = this.maxSafeDepth || 500; 
        
        const pressPct = Math.min(100, (dM / safeDepth) * 100);
        this._hudWidth(pressBar, `${pressPct}%`);
        const pressCol = dM >= safeDepth ? '#ff334b' : (dM >= safeDepth * 0.85 ? '#ff9f1c' : '#00d2ff');
        if (pressBar.__c !== pressCol) { pressBar.__c = pressCol; pressBar.style.background = pressCol; }
      }


      // 3. تحديث لوحة قياسات الغواصة التكتيكية (يمين الشاشة)
      const telPanel = document.getElementById('sub-telemetry-panel');
      if (telPanel) telPanel.style.display = inSub ? 'flex' : 'none';

      if (inSub && this.submarine) {
        const subSpeed = Math.round(Math.hypot(this.submarine.vx, this.submarine.vy) * 0.18);
        const subFuel = Math.round(Math.max(10, 100 - (this.submarine.timer % 100)));

        const telOxyVal = document.getElementById('tel-oxy-val');
        const telOxyFill = document.getElementById('tel-oxy-fill');
        const telEnergyVal = document.getElementById('tel-energy-val');
        const telEnergyFill = document.getElementById('tel-energy-fill');
        const telDepthVal = document.getElementById('tel-depth-val');
        const telDepthFill = document.getElementById('tel-depth-fill');
        const telSpeedVal = document.getElementById('tel-speed-val');
        const telSpeedFill = document.getElementById('tel-speed-fill');

        this._hudText(telOxyVal, `${curOxy} / 100`);
        this._hudWidth(telOxyFill, `${curOxy}%`);
        this._hudText(telEnergyVal, `${subFuel} / 100`);
        this._hudWidth(telEnergyFill, `${subFuel}%`);
        this._hudText(telDepthVal, `- ${dM} m`);
        this._hudWidth(telDepthFill, `${Math.min(100, (dM / 500) * 100)}%`);
        this._hudText(telSpeedVal, `${subSpeed} km/h`);
        this._hudWidth(telSpeedFill, `${Math.min(100, (subSpeed / 45) * 100)}%`);
      }

      if (inSub) {
        const sub = this.submarine;
        const subDepthM = Math.max(0, (sub.y - WORLD.WATER_Y) / WORLD.PIXELS_PER_METER);
        const bars = 1.0 + (subDepthM / 10);
        if (this.pressureVal) this.pressureVal.textContent = bars.toFixed(1);

        // حركة رقاص الضغط: يبدأ من أقصى اليسار ويصل لأقصى اليمين عند 500م
        const progress = Math.min(1.0, subDepthM / 500);
        const needleAngle = -65 + progress * 130;
        if (this.gaugeNeedle) {
          const needleT = `rotate(${needleAngle}deg)`;
          if (this.gaugeNeedle.__t !== needleT) { this.gaugeNeedle.__t = needleT; this.gaugeNeedle.style.transform = needleT; }
          const needleC = subDepthM >= 500 ? '#ff1744' : (subDepthM >= 440 ? '#ffa000' : '#00e5ff');
          if (this.gaugeNeedle.__c !== needleC) { this.gaugeNeedle.__c = needleC; this.gaugeNeedle.style.stroke = needleC; }
        }

        // شريط امتلاء الهيكل باللون الأحمر الصاعد
        const dmgPct = Math.max(0, Math.min(100, 100 - sub.health));
        if (this.hullDamageFill && this._lastDmgPct !== dmgPct) {
          this._lastDmgPct = dmgPct;
          const fillH = (dmgPct / 100) * 40;
          this.hullDamageFill.setAttribute('y', 40 - fillH);
          this.hullDamageFill.setAttribute('height', fillH);
        }
        if (this.hullHpText) {
          this._hudText(this.hullHpText, `${Math.round(sub.health)}%`);
          const hullC = sub.health < 40 ? '#ff1744' : (sub.health < 80 ? '#ffa000' : '#00e5ff');
          if (this.hullHpText.__c !== hullC) { this.hullHpText.__c = hullC; this.hullHpText.style.color = hullC; }
        }

        // تنبيهات الخطر الحقيقية بالأيقونات والنصوص
        if (this.subWarnBanner) {
          if (subDepthM >= 500) {
            this.subWarnBanner.classList.remove('hidden');
            this._hudText(this.subWarnBanner, sub.health < 30 ? '⚠ خطر سحق وشيك! اصعد فوراً' : '⚠ تم تجاوز حد الضغط! الغواصة تتضرر');
          } else if (subDepthM >= 440) {
            this.subWarnBanner.classList.remove('hidden');
            this._hudText(this.subWarnBanner, '⚡ تحذير: اقتراب من حد الضغط الأقصى (500م)');
          } else {
            this.subWarnBanner.classList.add('hidden');
          }
        }

        // وميض حواف الشاشة الحمراء (Vignette) عند تضرر الغواصة
        if (this.damageVignette) {
          const vigAlpha = (subDepthM >= 500 && sub.health > 0) ? (0.35 + Math.sin(performance.now() * 0.008) * 0.35) : 0;
          this.damageVignette.style.opacity = vigAlpha.toFixed(2);
        }
      } else {
        if (this.subWarnBanner) this.subWarnBanner.classList.add('hidden');
        if (this.damageVignette) this.damageVignette.style.opacity = '0';
      }
    }

    // تم استبداله: نظام الرادار التكتيكي الشامل بدون تعليق

    initRadarTouchPan() {
      if (!this.mapCanvas) return;
      const mc = this.mapCanvas;
      const activeTouches = new Map();

      mc.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (activeTouches.size === 1) {
          this.mapCam.isDrag = true;
          this.mapCam.lastX = e.clientX;
          this.mapCam.lastY = e.clientY;
        } else if (activeTouches.size === 2) {
          const pts = Array.from(activeTouches.values());
          this.mapCam.initDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          this.mapCam.initZoom = this.mapCam.zoom;
        }
        try { mc.setPointerCapture(e.pointerId); } catch (_) {}
      });

      mc.addEventListener('pointermove', (e) => {
        if (!activeTouches.has(e.pointerId)) return;
        activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });

        if (activeTouches.size === 1 && this.mapCam.isDrag) {
          const dx = e.clientX - this.mapCam.lastX;
          const dy = e.clientY - this.mapCam.lastY;
          this.mapCam.lastX = e.clientX;
          this.mapCam.lastY = e.clientY;
          this.mapCam.panX += dx;
          this.mapCam.panY += dy;
        } else if (activeTouches.size === 2) {
          const pts = Array.from(activeTouches.values());
          const curDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
          if (this.mapCam.initDist > 8) {
            const factor = curDist / this.mapCam.initDist;
            this.mapCam.zoom = Math.max(0.85, Math.min(4.5, this.mapCam.initZoom * factor));
          }
        }
      });

      const onEnd = (e) => {
        activeTouches.delete(e.pointerId);
        if (activeTouches.size === 0) this.mapCam.isDrag = false;
        try { mc.releasePointerCapture(e.pointerId); } catch (_) {}
      };
      mc.addEventListener('pointerup', onEnd);
      mc.addEventListener('pointercancel', onEnd);
    }

    renderMinimap() {
      if (!this.mapCtx || !this.mapCanvas) return;
      const mCtx = this.mapCtx;
      const w = this.mapCanvas.width = this.mapCanvas.clientWidth || 300;
      const h = this.mapCanvas.height = this.mapCanvas.clientHeight || 180;
      mCtx.clearRect(0, 0, w, h);

      // خلفية رادار خضراء شفافة بدون نصوص
      mCtx.fillStyle = 'rgba(2, 14, 9, 0.85)';
      mCtx.fillRect(0, 0, w, h);

      const pL = 20, pR = w - 20, pT = 20, pB = h - 20;
      const dW = pR - pL;
      const dH = pB - pT;

      const toRx = (wx) => pL + (wx / WORLD.WIDTH) * dW;
      const toRy = (wy) => {
        const dM = Math.max(0, (wy - WORLD.WATER_Y) / WORLD.PIXELS_PER_METER);
        if (dM <= 100) return pT + (dM / 100) * (dH * 0.32);
        return pT + dH * 0.32 + ((dM - 100) / 10900) * (dH * 0.68);
      };

      mCtx.save();
      // تطبيق إزاحة وتكبير الكاميرا 360°
      mCtx.translate(w * 0.5, h * 0.5);
      mCtx.scale(this.mapCam.zoom, this.mapCam.zoom);
      mCtx.translate(-w * 0.5 + this.mapCam.panX, -h * 0.5 + this.mapCam.panY);

      // شبكة رادار نقية خالية من النصوص
      this._drawRadarGrid(mCtx, pL, pR, pT, pB, toRy);

      // تضاريس مغلّقة بجبال صاعدة في أقصى اليسار
      this._drawRadarTerrainWireframe(mCtx, toRx, toRy);

      // نقاط الغواصة واللاعب بدون أي نصوص
      this._drawRadarBlips(mCtx, toRx, toRy);
      mCtx.restore();
    }

    // رسم تضاريس الرادار القديم أُلغي — يُستخدم الإطار السلكي _drawRadarTerrainWireframe مباشرة
    _drawRadarGrid(mCtx, pL, pR, pT, pB, toRy) {

      mCtx.save();
      mCtx.strokeStyle = 'rgba(46, 213, 115, 0.12)';
      mCtx.lineWidth = 0.8;

      const depths = [0, 50, 100, 5000, 11000];
      for (const d of depths) {
        const ry = toRy(WORLD.WATER_Y + d * WORLD.PIXELS_PER_METER);
        mCtx.beginPath();
        mCtx.moveTo(pL, ry);
        mCtx.lineTo(pR, ry);
        mCtx.stroke();
      }
      mCtx.restore();
    }

    _drawRadarTerrainWireframe(mCtx, toRx, toRy) {
      mCtx.save();
      mCtx.strokeStyle = '#2ed573';
      mCtx.lineWidth = 1.8;
      mCtx.shadowColor = 'rgba(46, 213, 115, 0.6)';
      mCtx.shadowBlur = 4;

      mCtx.beginPath();
      // 1. الشاطئ الرملي يميناً
      mCtx.moveTo(toRx(WORLD.WIDTH), toRy(WORLD.WATER_Y - 20));
      mCtx.lineTo(toRx(WORLD.SHORE_X), toRy(WORLD.WATER_Y));

      // 2. انحدار الرمال وصولاً للجدار
      for (let x = WORLD.SHORE_X; x >= WORLD.WALL_X; x -= 350) {
        mCtx.lineTo(toRx(x), toRy(this.terrain.getHeightAt(x)));
      }

      // 3. الجدار السحيق وصولاً لقاع ماريانا
      for (let y = 1000; y <= 66400; y += 4500) {
        mCtx.lineTo(toRx(this.terrain.getWallX(y)), toRy(y));
      }

      // 4. قاع خندق ماريانا
      mCtx.lineTo(toRx(1400), toRy(66400));

      // 5. تضاريس جبلية صاعدة تغلق أقصى اليسار
      mCtx.lineTo(toRx(950), toRy(48000));
      mCtx.lineTo(toRx(550), toRy(29000));
      mCtx.lineTo(toRx(180), toRy(11000));
      mCtx.lineTo(toRx(0), toRy(WORLD.WATER_Y + 400));
      mCtx.stroke();
      mCtx.restore();
    }

    _drawRadarBlips(mCtx, toRx, toRy) {
      const now = performance.now();
      const inSub = !!(this.submarine && this.submarine.occupied);
      mCtx.save();

      // رسم الغواصة (نقطة زرقاء نيون)
      if (this.submarine) {
        const sx = toRx(this.submarine.x);
        const sy = toRy(this.submarine.y);
        mCtx.fillStyle = '#00d2ff';
        mCtx.shadowColor = '#00d2ff';
        mCtx.shadowBlur = 8;
        mCtx.beginPath();
        mCtx.arc(sx, sy, 3.8, 0, Math.PI * 2);
        mCtx.fill();

        // نبض حول الغواصة إذا كان اللاعب بداخلها
        if (inSub) {
          const t2s = (now % 2000) / 2000;
          mCtx.strokeStyle = `rgba(0, 210, 255, ${(1 - t2s).toFixed(2)})`;
          mCtx.lineWidth = 1.3;
          mCtx.shadowBlur = 0;
          mCtx.beginPath();
          mCtx.arc(sx, sy, 3 + t2s * 15, 0, Math.PI * 2);
          mCtx.stroke();
        }
      }

      // رسم اللاعب (نقطة خضراء بنبض كل ثانيتين - فقط إذا كان خارج الغواصة)
      if (this.fisherman && !inSub) {
        const fx = toRx(this.fisherman.x);
        const fy = toRy(this.fisherman.y);
        const t2s = (now % 2000) / 2000;

        mCtx.strokeStyle = `rgba(46, 213, 115, ${(1 - t2s).toFixed(2)})`;
        mCtx.lineWidth = 1.3;
        mCtx.shadowBlur = 0;
        mCtx.beginPath();
        mCtx.arc(fx, fy, 3 + t2s * 14, 0, Math.PI * 2);
        mCtx.stroke();

        mCtx.fillStyle = '#2ed573';
        mCtx.shadowColor = '#2ed573';
        mCtx.shadowBlur = 8;
        mCtx.beginPath();
        mCtx.arc(fx, fy, 3.8, 0, Math.PI * 2);
        mCtx.fill();
      }
      mCtx.restore();
    }
  }

  // =========================================================================
  // 9. DEVELOPER MOD MENU CONTROLLER (DRAGGABLE FAB & PERSISTENT TOOLKIT)
  // =========================================================================
  class DevModMenu {
    constructor(introFlow) {
      this.engine = null;
      this.introFlow = introFlow;
      this.panel = document.getElementById('dev-panel');
      this.fab = document.getElementById('dev-fab-toggle');
      this.header = document.getElementById('dev-panel-header');
      this.btnClose = document.getElementById('dev-btn-close');

      // حالات وإعدادات المطور المحفوظة حياً
      this.godMode = false;
      this.speedMultiplier = 1.0;
      this.jumpMultiplier = 1.0;

      // سحب الزر العائم (FAB)
      this.isDraggingFab = false;
      this.fabStartX = 0;
      this.fabStartY = 0;
      this.fabInitLeft = 0;
      this.fabInitTop = 0;
      this.fabMoved = false;

      // سحب لوحة التحكم
      this.isDraggingPanel = false;
      this.panelStartX = 0;
      this.panelStartY = 0;
      this.panelInitLeft = 0;
      this.panelInitTop = 0;

      this.initEvents();
    }

    setEngine(engine) {
      this.engine = engine;
      // تطبيق الإعدادات المسبقة فور استلام المحرك
      if (this.engine && this.engine.fisherman) {
        this.engine.fisherman.godMode = this.godMode;
        this.engine.fisherman.speedMultiplier = this.speedMultiplier;
        this.engine.fisherman.jumpMultiplier = this.jumpMultiplier;
      }
    }

    togglePanel() {
      if (!this.panel) return;
      this.panel.classList.toggle('hidden');
    }

    closePanel() {
      if (!this.panel) return;
      this.panel.classList.add('hidden');
    }

    initEvents() {
      if (!this.panel || !this.fab) return;

      // ---------------------------------------------------------------------
      // 1. نظام سحب ونقر الزر العائم (Floating Action Button Drag & Click)
      // ---------------------------------------------------------------------
      this.fab.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this.isDraggingFab = true;
        this.fabMoved = false;
        this.fabStartX = e.clientX;
        this.fabStartY = e.clientY;

        const rect = this.fab.getBoundingClientRect();
        this.fabInitLeft = rect.left;
        this.fabInitTop = rect.top;

        try { this.fab.setPointerCapture(e.pointerId); } catch (_) {}
      });

      this.fab.addEventListener('pointermove', (e) => {
        if (!this.isDraggingFab) return;
        const dx = e.clientX - this.fabStartX;
        const dy = e.clientY - this.fabStartY;

        // إذا تحرك الإصبع أكثر من 4 بكسل نعتبرها حركة سحب وليست نقرة
        if (Math.hypot(dx, dy) > 4) {
          this.fabMoved = true;
          const maxW = Math.max(0, window.innerWidth - this.fab.offsetWidth);
          const maxH = Math.max(0, window.innerHeight - this.fab.offsetHeight);
          const newX = Math.max(0, Math.min(maxW, this.fabInitLeft + dx));
          const newY = Math.max(0, Math.min(maxH, this.fabInitTop + dy));

          this.fab.style.left = `${newX}px`;
          this.fab.style.top = `${newY}px`;
          this.fab.style.right = 'auto';
          this.fab.style.bottom = 'auto';
        }
      });

      const onFabRelease = (e) => {
        if (!this.isDraggingFab) return;
        this.isDraggingFab = false;
        try { this.fab.releasePointerCapture(e.pointerId); } catch (_) {}

        // إذا لم يتم سحبه، تُعتبر نقرة صريحة لفتح/إغلاق القائمة
        if (!this.fabMoved) {
          this.togglePanel();
        }
      };

      this.fab.addEventListener('pointerup', onFabRelease);
      this.fab.addEventListener('pointercancel', onFabRelease);

      if (this.btnClose) {
        this.btnClose.addEventListener('click', (e) => {
          e.stopPropagation();
          this.closePanel();
        });
      }

      // ---------------------------------------------------------------------
      // 2. نظام سحب وتحريك لوحة التحكم (Panel Header Drag & Drop)
      // ---------------------------------------------------------------------
      if (this.header) {
        this.header.addEventListener('pointerdown', (e) => {
          e.stopPropagation();
          this.isDraggingPanel = true;
          this.panelStartX = e.clientX;
          this.panelStartY = e.clientY;

          const rect = this.panel.getBoundingClientRect();
          this.panelInitLeft = rect.left;
          this.panelInitTop = rect.top;

          try { this.header.setPointerCapture(e.pointerId); } catch (_) {}
        });

        this.header.addEventListener('pointermove', (e) => {
          if (!this.isDraggingPanel) return;
          const dx = e.clientX - this.panelStartX;
          const dy = e.clientY - this.panelStartY;

          const maxW = Math.max(0, window.innerWidth - this.panel.offsetWidth);
          const maxH = Math.max(0, window.innerHeight - this.panel.offsetHeight);
          const newX = Math.max(0, Math.min(maxW, this.panelInitLeft + dx));
          const newY = Math.max(0, Math.min(maxH, this.panelInitTop + dy));

          this.panel.style.left = `${newX}px`;
          this.panel.style.top = `${newY}px`;
          this.panel.style.right = 'auto';
          this.panel.style.bottom = 'auto';
        });

        const onPanelRelease = (e) => {
          this.isDraggingPanel = false;
          try { this.header.releasePointerCapture(e.pointerId); } catch (_) {}
        };
        this.header.addEventListener('pointerup', onPanelRelease);
        this.header.addEventListener('pointercancel', onPanelRelease);
      }

      // ---------------------------------------------------------------------
      // 3. أزرار التحكم والخيارات داخل القائمة
      // ---------------------------------------------------------------------

      // زر التخطي السريع إلى اللعبة
      const btnSkip = document.getElementById('dev-btn-fast-skip');
      if (btnSkip) {
        btnSkip.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.introFlow) this.introFlow.fastSkipDirectly();
        });
      }

      // وضع الخلود (God Mode)
      const btnGod = document.getElementById('dev-btn-god');
      if (btnGod) {
        btnGod.addEventListener('click', (e) => {
          e.stopPropagation();
          this.godMode = !this.godMode;
          if (this.engine && this.engine.fisherman) {
            this.engine.fisherman.godMode = this.godMode;
          }
          btnGod.classList.toggle('active-opt', this.godMode);
          btnGod.textContent = this.godMode ? 'الخلود: مفعّل 🛡️' : 'الخلود: معطل';
        });
      }

      // تعبئة الصحة والأكسجين
      const btnHeal = document.getElementById('dev-btn-heal');
      if (btnHeal) {
        btnHeal.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.engine && this.engine.fisherman) {
            this.engine.fisherman.health = 100;
            this.engine.fisherman.oxygen = 100;
            this.engine.fisherman.isDead = false;
          }
        });
      }

      // إصلاح الغواصة
      const btnFixSub = document.getElementById('dev-btn-fix-sub');
      if (btnFixSub) {
        btnFixSub.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this.engine && this.engine.submarine) {
            this.engine.submarine.health = 100;
            this.engine.submarine.isCrushed = false;
            this.engine.submarine.crushAnim = 0;
            this.engine.submarine.bloodPlume = [];
            this.engine.submarine.cracks = [];
            this.engine.submarine.lightsOn = true;
          }
        });
      }

      // سرعة الحركة
      const spdVal = document.getElementById('dev-speed-val');
      document.querySelectorAll('.dev-speed-opt').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          document.querySelectorAll('.dev-speed-opt').forEach(b => b.classList.remove('active-opt'));
          btn.classList.add('active-opt');
          this.speedMultiplier = parseFloat(btn.getAttribute('data-spd')) || 1.0;
          if (this.engine && this.engine.fisherman) {
            this.engine.fisherman.speedMultiplier = this.speedMultiplier;
          }
          if (spdVal) spdVal.textContent = `${this.speedMultiplier}x`;
        });
      });

      // قوة القفز
      const jmpVal = document.getElementById('dev-jump-val');
      document.querySelectorAll('.dev-jump-opt').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          document.querySelectorAll('.dev-jump-opt').forEach(b => b.classList.remove('active-opt'));
          btn.classList.add('active-opt');
          this.jumpMultiplier = parseFloat(btn.getAttribute('data-jmp')) || 1.0;
          if (this.engine && this.engine.fisherman) {
            this.engine.fisherman.jumpMultiplier = this.jumpMultiplier;
          }
          if (jmpVal) jmpVal.textContent = `${this.jumpMultiplier}x`;
        });
      });

      // الطقس
      document.querySelectorAll('.dev-wthr-opt').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          document.querySelectorAll('.dev-wthr-opt').forEach(b => b.classList.remove('active-opt'));
          btn.classList.add('active-opt');
          const w = btn.getAttribute('data-w');
          if (this.engine && this.engine.dayNight) {
            this.engine.dayNight.weather = w;
            this.engine.dayNight.updateColors();
          }
        });
      });

      // الوقت
      document.querySelectorAll('.dev-time-opt').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          document.querySelectorAll('.dev-time-opt').forEach(b => b.classList.remove('active-opt'));
          btn.classList.add('active-opt');
          const t = parseFloat(btn.getAttribute('data-t')) || 0;
          if (this.engine && this.engine.dayNight) {
            this.engine.dayNight.time = t;
            this.engine.dayNight.updateColors();
          }
        });
      });

      // الانتقال الآني (Teleport)
      document.querySelectorAll('.dev-tp-opt').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!this.engine) return;
          const targetDepthM = parseFloat(btn.getAttribute('data-depth')) || 0;
          const targetY = WORLD.WATER_Y + targetDepthM * WORLD.PIXELS_PER_METER;

          let targetX = 8500;
          if (targetDepthM >= 100) {
            targetX = WORLD.WALL_X - 150;
          }

          if (this.engine.submarine && this.engine.submarine.occupied) {
            this.engine.submarine.x = targetX;
            this.engine.submarine.y = targetY;
            this.engine.submarine.vx = 0;
            this.engine.submarine.vy = 0;
            if (this.engine.camera) {
              this.engine.camera.x = targetX;
              this.engine.camera.y = targetY;
            }
          } else if (this.engine.fisherman) {
            this.engine.fisherman.x = targetX;
            this.engine.fisherman.y = targetY;
            this.engine.fisherman.vx = 0;
            this.engine.fisherman.vy = 0;
            if (this.engine.camera) {
              this.engine.camera.x = targetX;
              this.engine.camera.y = targetY;
            }
          }
        });
      });
    }
  }

  // بدء تشغيل المحرك مع نظام التدفق الأولي والتحميل المسبق
  window.addEventListener('DOMContentLoaded', () => {
    let devMenuInstance = null;
    const introFlow = new IntroFlowManager((preloadedAudio, preloadedAudioCtx) => {
      const gameEngine = new Engine();
      window.__GAME_ENGINE__ = gameEngine;

      if (devMenuInstance) {
        devMenuInstance.setEngine(gameEngine);
      }
      // دمج AudioContext المسبق وذاكرة الأصوات المحملة
      if (preloadedAudioCtx && gameEngine.audioManager) {
        gameEngine.audioManager.ctx = preloadedAudioCtx;
        gameEngine.audioManager.unlocked = true;
        try {
          gameEngine.audioManager.masterGain = preloadedAudioCtx.createGain();
          gameEngine.audioManager.masterGain.gain.value = 0.85;
          gameEngine.audioManager.masterGain.connect(preloadedAudioCtx.destination);

          gameEngine.audioManager.subBus = preloadedAudioCtx.createGain();
          gameEngine.audioManager.subBus.gain.value = 0.9;
          gameEngine.audioManager.subBus.connect(gameEngine.audioManager.masterGain);

          gameEngine.audioManager.ambientBus = preloadedAudioCtx.createGain();
          gameEngine.audioManager.ambientBus.gain.value = 0.75;
          gameEngine.audioManager.ambientBus.connect(gameEngine.audioManager.masterGain);

          gameEngine.audioManager.sfxBus = preloadedAudioCtx.createGain();
          gameEngine.audioManager.sfxBus.gain.value = 0.6;
          gameEngine.audioManager.sfxBus.connect(gameEngine.audioManager.masterGain);
        } catch (_) {}
      }

      if (preloadedAudio.whale && gameEngine.whaleAudio) {
        gameEngine.whaleAudio.buffer = preloadedAudio.whale;
        gameEngine.whaleAudio.audio = preloadedAudioCtx;
        gameEngine.whaleAudio.master = gameEngine.audioManager ? gameEngine.audioManager.ambientBus : null;
        gameEngine.whaleAudio.ready = true;
      }
      if (preloadedAudio.diving && gameEngine.diveAudio) {
        gameEngine.diveAudio.buffer = preloadedAudio.diving;
        gameEngine.diveAudio.audio = preloadedAudioCtx;
        gameEngine.diveAudio.outNode = gameEngine.audioManager ? gameEngine.audioManager.ambientBus : null;
        gameEngine.diveAudio.ready = true;
      }

      if (preloadedAudio.warning) {
        gameEngine.submarine.warningBuffer = preloadedAudio.warning;
        gameEngine.submarine.warningAudioCtx = preloadedAudioCtx;
        gameEngine.submarine.warningBus = gameEngine.audioManager
          ? gameEngine.audioManager.sfxBus
          : null;
      }

      if (preloadedAudio.unknown) {
        gameEngine.fauna.unknownBuffer = preloadedAudio.unknown;
        gameEngine.fauna.unknownAudioCtx = preloadedAudioCtx;
        gameEngine.fauna.unknownBus = gameEngine.audioManager
          ? gameEngine.audioManager.sfxBus
          : null;
      }

      // تطبيق مستوى الصوت المختار في الـLobby على خلاط الصوت الرئيسي
      try {
        const savedVol = parseFloat(localStorage.getItem('marine_master_vol'));
        if (Number.isFinite(savedVol) && gameEngine.audioManager && gameEngine.audioManager.masterGain) {
          gameEngine.audioManager.masterGain.gain.value = Math.max(0, Math.min(1, savedVol));
        }
      } catch (_) {}
      const volInputEl = document.getElementById('lobby-volume');
      if (volInputEl && gameEngine.audioManager && gameEngine.audioManager.masterGain) {
        volInputEl.addEventListener('input', () => {
          const v = Math.max(0, Math.min(100, parseInt(volInputEl.value, 10) || 0)) / 100;
          gameEngine.audioManager.masterGain.gain.value = v;
        });
      }

      // تطبيق جودة الرسومات من اللوبي مباشرة أثناء اللعب (بدون إعادة تشغيل)
      const qSelLive = document.getElementById('lobby-quality');
      if (qSelLive) {
        qSelLive.addEventListener('change', () => {
          Quality.set(qSelLive.value);
          if (gameEngine.fauna) gameEngine.fauna.poolSize = Quality.q.fauna;
        });
      }

      gameEngine.start();
    });

    // تهيئة قائمة المطور فور تحميل الصفحة لتعمل من أول لحظة بدون تكرار مستمعات
    devMenuInstance = new DevModMenu(introFlow);
  });
})();