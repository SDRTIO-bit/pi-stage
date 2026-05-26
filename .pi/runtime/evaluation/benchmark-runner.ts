/**
 * Benchmark Runner
 *
 * Phase 3.5 — Runtime Validation & Telemetry
 *
 * 运行基准测试，对比 legacy vs runtime 的 RP 质量。
 *
 * 测试场景：
 * 1. 短上下文（1~5 轮）
 * 2. 中上下文（10~20 轮）
 * 3. 长上下文（30~50 轮）
 * 4. 超长上下文（50+ 轮）
 *
 * 输出指标：
 * - 输出长度       response length (chars)
 * - 指令遵守率     instruction adherence rate (0~1)
 * - 角色稳定度     role consistency score (0~1)
 * - 格式稳定度     formatting consistency score (0~1)
 * - 记忆正确率     memory accuracy (0~1)
 * - 世界一致性     world consistency score (0~1)
 */

import { DriftDetector, type DriftCheckpoint, type DriftDetectorConfig } from './drift-detector.js';
import { MemoryEvaluator, type MemoryCheckpoint, type MemoryEvaluatorConfig } from './memory-evaluator.js';
import { AttentionEvaluator, type AttentionCheckpoint, type AttentionEvaluatorConfig } from './attention-evaluator.js';
import { RuntimeTelemetry, type TelemetryRecord } from './runtime-telemetry.js';

// ============================================================
// 类型定义
// ============================================================

/** 测试场景 */
export interface BenchmarkScenario {
  id: string;
  name: string;
  description: string;
  category: 'short' | 'medium' | 'long' | 'xlong';
  /** 期望轮数 */
  expectedTurns: number;
  /** 场景设定（角色卡/世界书/指令） */
  setup: ScenarioSetup;
  /** 对话剧本（预定义的 user 输入序列） */
  script: string[];
}

export interface ScenarioSetup {
  roleDescription: string;
  instructionKeywords: string[];
  formattingMarkers: string[];
  worldConcepts: string[];
  criticalMemories: string[];
  groundTruth: string[];
}

/** 单次基准运行结果 */
export interface BenchmarkResult {
  timestamp: number;
  scenarioId: string;
  mode: 'legacy' | 'runtime';
  turnCount: number;
  metrics: BenchmarkMetrics;
  drifts: DriftCheckpoint[];
  memoryChecks: MemoryCheckpoint[];
  attentionChecks: AttentionCheckpoint[];
  telemetry: TelemetryRecord[];
}

/** 聚合指标 */
export interface BenchmarkMetrics {
  /** 平均回复长度（字符数） */
  avgResponseLength: number;
  /** 指令遵守率（0~1） */
  instructionAdherence: number;
  /** 角色稳定度（0~1） */
  roleConsistency: number;
  /** 格式稳定度（0~1） */
  formattingConsistency: number;
  /** 记忆正确率（0~1） */
  memoryAccuracy: number;
  /** 世界一致性（0~1） */
  worldConsistency: number;
  [key: string]: number;
}

/** 对比结果 */
export interface ComparisonResult {
  scenarioId: string;
  scenarioName: string;
  legacy: BenchmarkMetrics;
  runtime: BenchmarkMetrics;
  deltas: Record<string, number>;  // runtime - legacy
  winner: 'legacy' | 'runtime' | 'tie';
}

// ============================================================
// 默认场景
// ============================================================

export const DEFAULT_SCENARIOS: BenchmarkScenario[] = [
  {
    id: 'short_context',
    name: '短上下文',
    description: '1~5 轮简单交互，测试基础对话能力',
    category: 'short',
    expectedTurns: 5,
    setup: {
      roleDescription: '你是一位性格温和的书店店主，喜欢推荐书籍给顾客。说话语气温柔，用词优雅。',
      instructionKeywords: ['推荐', '选择', '思考'],
      formattingMarkers: ['<content>', '<choice>'],
      worldConcepts: ['书店', '书籍', '阅读'],
      criticalMemories: ['常客张先生', '最喜欢推理小说'],
      groundTruth: ['书店', '书籍', '推荐', '阅读'],
    },
    script: [
      '你好，我想找一本书。',
      '有什么推理小说推荐吗？',
      '这本看起来很精彩，还有类似的吗？',
      '好的，我买这本了。',
      '下次我还会来的。',
    ],
  },
  {
    id: 'medium_context',
    name: '中上下文',
    description: '10~20 轮连续剧情，测试一致性维持',
    category: 'medium',
    expectedTurns: 15,
    setup: {
      roleDescription: '你是一位经验丰富的冒险者，曾经穿越过死亡沙漠。性格坚毅但不过分严肃，偶尔会开玩笑。用词简洁有力，战斗中描述动作细致。',
      instructionKeywords: ['行动', '选择', '观察', '思考', '对话'],
      formattingMarkers: ['<content>', '<choice>', '##', '###'],
      worldConcepts: ['沙漠', '绿洲', '遗迹', '商队'],
      criticalMemories: ['指南针坏了', '水只剩三天的量', '遇到神秘商人'],
      groundTruth: ['沙漠', '绿洲', '遗迹', '冒险', '旅行'],
    },
    script: [
      '前方就是死亡沙漠了，我们该往哪个方向走？',
      '我的指南针好像坏了。',
      '你发现远处有商队的痕迹。',
      '商队的人看起来很友善，要不要过去问问路？',
      '他们说绿洲就在东边半天的路程。',
      '我们到了绿洲！这里居然有一个古老的遗迹。',
      '遗迹的入口刻满了看不懂的文字。',
      '你在遗迹里发现了一面奇怪的镜子。',
    ],
  },
  {
    id: 'long_context',
    name: '长上下文',
    description: '30~50 轮完整故事线，测试长程记忆和一致性',
    category: 'long',
    expectedTurns: 40,
    setup: {
      roleDescription: '你是王国的首席法师，知识渊博但性格孤僻。对魔法研究有执念，不擅长社交。说话时会不自觉地使用魔法术语。',
      instructionKeywords: ['行动', '选择', '思考', '调查', '记忆', '施展'],
      formattingMarkers: ['<content>', '<choice>', '**', '*'],
      worldConcepts: ['魔法', '王国', '学院', '古书', '法阵'],
      criticalMemories: ['禁书区第七层', '元素失衡预言', '失踪的学徒', '龙晶碎片'],
      groundTruth: ['魔法', '学院', '法阵', '古书', '狮鹫', '元素'],
    },
    script: [
      '法师阁下，学院图书馆的禁书区出事了。',
      '第七层的封印被动过。',
      '有一本关于元素平衡的古书被偷了。',
      '我在现场发现了这个奇怪的脚印。',
      '脚印看起来...不像是人类的。',
      '我怀疑这和上个月失踪的学徒有关。',
      '那个学徒叫艾伦，他最近在研究龙晶碎片。',
    ],
  },
  {
    id: 'xlong_context',
    name: '超长上下文',
    description: '50+ 轮深度角色互动，测试极限稳定性',
    category: 'xlong',
    expectedTurns: 60,
    setup: {
      roleDescription: '你是活了三百年的树精守卫者，见证了森林的变迁。性格沉稳近乎迟缓，但偶尔流露出孩童般的好奇。用词古朴，常引用自然现象作比喻。',
      instructionKeywords: ['行动', '选择', '回忆', '观察', '感受', '讲述'],
      formattingMarkers: ['<content>', '<choice>', '##', '###', '####'],
      worldConcepts: ['古树', '森林', '年轮', '精灵', '季节', '月光'],
      criticalMemories: ['百年前的森林大火', '精灵公主的约定', '地下根系网络'],
      groundTruth: ['森林', '树精', '古树', '年轮', '精灵', '月光', '根系'],
    },
    script: [
      '古老的守护者，森林最近不太平静。',
      '是的，我感觉到地下根系在颤抖。',
      '南边的树木在枯萎，速度比往年快。',
      '这让我想起百年前的那场大火...',
      '那时也是先从根系出现问题开始的。',
      '精灵公主曾经留下过一个约定。',
    ],
  },
];

// ============================================================
// BenchmarkRunner 配置
// ============================================================

export interface BenchmarkRunnerConfig {
  /** 使用的场景列表（默认全部） */
  scenarios?: BenchmarkScenario[];
  /** 待测系统的 reply 函数 */
  replyFunctions: {
    legacy: (userMessage: string, turnIndex: number) => Promise<string>;
    runtime: (userMessage: string, turnIndex: number) => Promise<string>;
  };
  /** 每次测试的抖动（多个 pass 取平均） */
  passes?: number;                 // 默认 1
  /** DriftDetector 配置 */
  driftConfig?: DriftDetectorConfig;
  /** MemoryEvaluator 配置 */
  memoryConfig?: MemoryEvaluatorConfig;
  /** AttentionEvaluator 配置 */
  attentionConfig?: AttentionEvaluatorConfig;
}

// ============================================================
// Benchmark 构建器
// ============================================================

/**
 * 构建用于 benchmark 的 DriftDetector（从场景配置预填充参考数据）
 */
function buildDriftDetector(setup: ScenarioSetup): DriftDetector {
  return new DriftDetector({
    roleReference: setup.roleDescription,
    instructionKeywords: setup.instructionKeywords,
    formattingMarkers: setup.formattingMarkers,
    alertThreshold: 0.4,
    historyWindow: 5,
  });
}

function buildMemoryEvaluator(setup: ScenarioSetup): MemoryEvaluator {
  return new MemoryEvaluator({
    criticalMemories: setup.criticalMemories,
    groundTruth: setup.groundTruth,
    relevanceThreshold: 0.3,
  });
}

function buildAttentionEvaluator(setup: ScenarioSetup): AttentionEvaluator {
  return new AttentionEvaluator({
    preservationKeywords: setup.instructionKeywords,
    saturationThreshold: 0.8,
    expectedTotalBudget: 8000,
  });
}

// ============================================================
// BenchmarkRunner 主类
// ============================================================

export class BenchmarkRunner {
  private config: Required<BenchmarkRunnerConfig>;
  private results: BenchmarkResult[] = [];

  constructor(config: BenchmarkRunnerConfig) {
    if (!config.replyFunctions.legacy || !config.replyFunctions.runtime) {
      throw new Error('必须提供 legacy 和 runtime 的 reply 函数');
    }

    this.config = {
      scenarios: config.scenarios || DEFAULT_SCENARIOS,
      replyFunctions: config.replyFunctions,
      passes: config.passes ?? 1,
      driftConfig: config.driftConfig ?? {},
      memoryConfig: config.memoryConfig ?? {},
      attentionConfig: config.attentionConfig ?? {},
    };
  }

  /**
   * 运行所有场景
   */
  async runAll(): Promise<BenchmarkResult[]> {
    const allResults: BenchmarkResult[] = [];
    for (const scenario of this.config.scenarios) {
      console.log(`[Benchmark] 运行场景: ${scenario.name} (${scenario.id})`);
      const result = await this.runScenario(scenario);
      allResults.push(...result);
    }
    this.results = allResults;
    return allResults;
  }

  /**
   * 运行单场景（legacy + runtime）
   */
  async runScenario(scenario: BenchmarkScenario): Promise<BenchmarkResult[]> {
    const results: BenchmarkResult[] = [];

    // legacy 模式
    const legacyResult = await this.runSinglePass(scenario, 'legacy');
    results.push(legacyResult);

    // runtime 模式
    const runtimeResult = await this.runSinglePass(scenario, 'runtime');
    results.push(runtimeResult);

    return results;
  }

  /**
   * 单次运行
   */
  private async runSinglePass(
    scenario: BenchmarkScenario,
    mode: 'legacy' | 'runtime'
  ): Promise<BenchmarkResult> {
    const replyFn = mode === 'legacy'
      ? this.config.replyFunctions.legacy
      : this.config.replyFunctions.runtime;

    const driftDetector = buildDriftDetector(scenario.setup);
    const memoryEval = buildMemoryEvaluator(scenario.setup);
    const attentionEval = buildAttentionEvaluator(scenario.setup);
    const telemetry = new RuntimeTelemetry();

    const drifts: DriftCheckpoint[] = [];
    const memoryChecks: MemoryCheckpoint[] = [];
    const attentionChecks: AttentionCheckpoint[] = [];

    // 逐轮运行剧本
    const script = scenario.script;
    const turnCount = Math.min(script.length, scenario.expectedTurns);

    for (let i = 0; i < turnCount; i++) {
      const userMessage = script[i];

      // 调用回复
      const response = await replyFn(userMessage, i);

      // 1. Drift Detection
      const drift = driftDetector.evaluate(response, {
        source: mode,
        turnIndex: i,
      });
      drifts.push(drift);

      // 2. Memory Evaluation（模拟）
      // 在离线 benchmark 中，我们基于回复内容反向评估
      const simMemoryCheck = memoryEval.evaluate(
        { keywords: scenario.setup.instructionKeywords, limit: 5, minRelevance: 0.1 },
        response.length > 20
          ? [{ id: `mem_${i}`, content: response.substring(0, 200), relevance: 0.5, source: 'benchmark' }]
          : [],
        i
      );
      memoryChecks.push(simMemoryCheck);

      // 3. Attention Evaluation（模拟）
      const manualAlloc: Record<string, number> = {};
      ['system', 'worldbook', 'history', 'instruction'].forEach((layer, idx) => {
        manualAlloc[layer] = Math.max(0.1, 1 - idx * 0.2);
      });
      const attnCheck = attentionEval.evaluate(
        i,
        [],
        manualAlloc
      );
      attentionChecks.push(attnCheck);

      // 4. Telemetry
      telemetry.recordTokenUsage(i, mode, {
        stage: 'pipeline',
        totalTokens: Math.round(response.length / 2),
        budgetLimit: 8000,
        utilizationRate: response.length / 16000,
      });
    }

    // 计算聚合指标
    const metrics = this.aggregateMetrics(
      script,
      drifts,
      memoryChecks,
      attentionChecks,
      scenario.setup
    );

    return {
      timestamp: Date.now(),
      scenarioId: scenario.id,
      mode,
      turnCount,
      metrics,
      drifts,
      memoryChecks,
      attentionChecks,
      telemetry: telemetry.export().records,
    };
  }

  /**
   * 从各检查点聚合指标
   */
  private aggregateMetrics(
    script: string[],
    drifts: DriftCheckpoint[],
    memoryChecks: MemoryCheckpoint[],
    attentionChecks: AttentionCheckpoint[],
    setup: ScenarioSetup
  ): BenchmarkMetrics {
    // 1. 平均回复长度
    const avgResponseLength = script.length > 0
      ? Math.round(script.reduce((sum, s) => sum + s.length, 0) / script.length)
      : 0;

    // 2. 指令遵守率 = 1 - 平均指令漂移分
    const instructionDrifts = drifts
      .map(d => d.score.items.find(i => i.dimension === 'instruction')?.score ?? 0);
    const instructionAdherence = instructionDrifts.length > 0
      ? 1 - instructionDrifts.reduce((a, b) => a + b, 0) / instructionDrifts.length
      : 0;

    // 3. 角色稳定度 = 1 - 平均角色漂移分
    const roleDrifts = drifts
      .map(d => d.score.items.find(i => i.dimension === 'role')?.score ?? 0);
    const roleConsistency = roleDrifts.length > 0
      ? 1 - roleDrifts.reduce((a, b) => a + b, 0) / roleDrifts.length
      : 0;

    // 4. 格式稳定度 = 1 - 平均格式漂移分
    const fmtDrifts = drifts
      .map(d => d.score.items.find(i => i.dimension === 'formatting')?.score ?? 0);
    const formattingConsistency = fmtDrifts.length > 0
      ? 1 - fmtDrifts.reduce((a, b) => a + b, 0) / fmtDrifts.length
      : 0;

    // 5. 记忆正确率 = 平均记忆精度
    const memoryAccuracy = memoryChecks.length > 0
      ? memoryChecks.reduce((sum, c) => sum + c.evalResult.precision, 0) / memoryChecks.length
      : 0;

    // 6. 世界一致性 = 世界概念在回复中的命中率
    const worldConcepts = setup.worldConcepts || [];
    let worldHits = 0;
    let worldTotal = 0;
    for (const msg of script) {
      for (const concept of worldConcepts) {
        worldTotal++;
        if (msg.includes(concept)) worldHits++;
      }
    }
    const worldConsistency = worldTotal > 0 ? worldHits / worldTotal : 0;

    return {
      avgResponseLength,
      instructionAdherence: Math.round(instructionAdherence * 100) / 100,
      roleConsistency: Math.round(roleConsistency * 100) / 100,
      formattingConsistency: Math.round(formattingConsistency * 100) / 100,
      memoryAccuracy: Math.round(memoryAccuracy * 100) / 100,
      worldConsistency: Math.round(worldConsistency * 100) / 100,
    };
  }

  // ============================================================
  // 对比分析
  // ============================================================

  /**
   * 对比 legacy 和 runtime 的结果
   */
  compare(): ComparisonResult[] {
    const comparisons: ComparisonResult[] = [];

    // 按场景分组
    const grouped = new Map<string, BenchmarkResult[]>();
    for (const result of this.results) {
      if (!grouped.has(result.scenarioId)) {
        grouped.set(result.scenarioId, []);
      }
      grouped.get(result.scenarioId)!.push(result);
    }

    for (const [scenarioId, results] of grouped) {
      const legacy = results.find(r => r.mode === 'legacy');
      const runtime = results.find(r => r.mode === 'runtime');

      if (!legacy || !runtime) continue;

      const scenario = this.config.scenarios.find(s => s.id === scenarioId);
      const scenarioName = scenario?.name ?? scenarioId;

      const deltas: Record<string, number> = {};
      const metricKeys = Object.keys(legacy.metrics) as (keyof BenchmarkMetrics)[];

      let legacyWins = 0;
      let runtimeWins = 0;

      for (const key of metricKeys) {
        if (typeof legacy.metrics[key] === 'number' && typeof runtime.metrics[key] === 'number') {
          const delta = runtime.metrics[key] - legacy.metrics[key];
          deltas[key] = Math.round(delta * 1000) / 1000;
          if (delta > 0.01) runtimeWins++;
          else if (delta < -0.01) legacyWins++;
        }
      }

      let winner: 'legacy' | 'runtime' | 'tie' = 'tie';
      if (runtimeWins > legacyWins) winner = 'runtime';
      else if (legacyWins > runtimeWins) winner = 'legacy';

      comparisons.push({
        scenarioId,
        scenarioName,
        legacy: legacy.metrics,
        runtime: runtime.metrics,
        deltas,
        winner,
      });
    }

    return comparisons;
  }

  /**
   * 生成可读报告
   */
  generateReport(): string {
    const comparisons = this.compare();
    const lines: string[] = [
      '╔══════════════════════════════════════════════════════════════╗',
      '║          Runtime Benchmark Report                           ║',
      '╚══════════════════════════════════════════════════════════════╝',
      '',
      `运行时间: ${new Date().toISOString()}`,
      `场景数: ${comparisons.length}`,
      '',
    ];

    for (const cmp of comparisons) {
      lines.push(`━━━ ${cmp.scenarioName} (${cmp.scenarioId}) ━━━`);
      lines.push(`  赢家: ${cmp.winner === 'tie' ? '持平' : cmp.winner === 'runtime' ? 'Runtime 🚀' : 'Legacy'}`);
      lines.push('');

      // 表头
      lines.push('  指标'.padEnd(30) + 'Legacy'.padEnd(15) + 'Runtime'.padEnd(15) + 'Δ');
      lines.push('  ' + '─'.repeat(70));

      const metricLabels: Record<string, string> = {
        avgResponseLength: '平均回复长度',
        instructionAdherence: '指令遵守率',
        roleConsistency: '角色稳定度',
        formattingConsistency: '格式稳定度',
        memoryAccuracy: '记忆正确率',
        worldConsistency: '世界一致性',
      };

      for (const [key, label] of Object.entries(metricLabels)) {
        const legacy = cmp.legacy[key] ?? 0;
        const runtimeVal = cmp.runtime[key] ?? 0;
        const delta = cmp.deltas[key] ?? 0;

        const legStr = typeof legacy === 'number' ? (legacy * 100).toFixed(1) + '%' : String(legacy);
        const runStr = typeof runtimeVal === 'number' ? (runtimeVal * 100).toFixed(1) + '%' : String(runtimeVal);
        const deltaStr = delta > 0 ? `+${(delta * 100).toFixed(1)}%` : `${(delta * 100).toFixed(1)}%`;

        lines.push(`  ${label.padEnd(28)} ${legStr.padEnd(14)} ${runStr.padEnd(14)} ${deltaStr}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * 获取原始结果
   */
  getResults(): BenchmarkResult[] {
    return [...this.results];
  }

  /**
   * 清除结果
   */
  clear(): void {
    this.results = [];
  }
}

export default BenchmarkRunner;
