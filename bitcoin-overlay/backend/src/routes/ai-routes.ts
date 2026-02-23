import { FastifyInstance } from 'fastify';
import { getCurrentPrice, getChartData } from '../services/coingecko.js';
import { analyzeChart } from '../services/ai-analysis.js';

export async function aiRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/analyze', async (request, reply) => {
    try {
      const { days = 30 } = (request.body as { days?: number }) || {};
      const daysNum = Math.max(1, Math.min(365, typeof days === 'number' ? days : 30));

      const [priceData, chartData] = await Promise.all([
        getCurrentPrice(),
        getChartData(daysNum),
      ]);

      const analysis = await analyzeChart(priceData, chartData, daysNum);
      return reply.send(analysis);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate analysis';
      fastify.log.error(error, 'Error generating AI analysis');
      return reply.status(500).send({ error: message });
    }
  });
}
