import { FastifyInstance } from 'fastify';
import { getCurrentPrice, getChartData } from '../services/coingecko';
import { resolvePredictions } from '../services/prediction-store';

export async function bitcoinRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/price', async (_request, reply) => {
    try {
      const priceData = await getCurrentPrice();

      // Auto-resolve expired predictions on each price fetch
      try {
        resolvePredictions(priceData.price);
      } catch (err) {
        fastify.log.error(err, 'Failed to resolve predictions');
      }

      return reply.send(priceData);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch price data';
      fastify.log.error(error, 'Error fetching price data');
      return reply.status(502).send({ error: message });
    }
  });

  fastify.get('/api/chart', async (request, reply) => {
    try {
      const { days = '30' } = request.query as { days?: string };
      const daysNum = Math.max(1, Math.min(365, parseInt(days, 10) || 30));
      const chartData = await getChartData(daysNum);
      return reply.send(chartData);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch chart data';
      fastify.log.error(error, 'Error fetching chart data');
      return reply.status(502).send({ error: message });
    }
  });
}
