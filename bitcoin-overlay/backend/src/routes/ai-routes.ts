import { FastifyInstance } from 'fastify';
import { getCurrentPrice, getChartData } from '../services/coingecko';
import { analyzeChart } from '../services/ai-analysis';
import { addPredictions } from '../services/prediction-store';

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

      // Store predictions if they are real (not fallback with 0 confidence)
      if (analysis.predictions?.length && analysis.predictions.some((p) => p.confidence > 0)) {
        try {
          addPredictions(analysis.predictions, priceData.price);
        } catch (err) {
          fastify.log.error(err, 'Failed to store predictions');
        }
      }

      return reply.send(analysis);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to generate analysis';
      fastify.log.error(error, 'Error generating AI analysis');
      return reply.status(500).send({ error: message });
    }
  });
}
