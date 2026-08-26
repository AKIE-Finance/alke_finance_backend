import { BadGatewayException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Client du fournisseur de taux de change gratuit et sans clé
 * (https://www.exchangerate-api.com, miroir open.er-api.com) - deja
 * utilise cote application mobile (fx_rate_service.dart). Aucune
 * inscription/compte n'est necessaire pour ce service : c'est la seule
 * integration "marche" que le backend peut brancher reellement des
 * aujourd'hui, sans attendre un partenaire.
 */
@Injectable()
export class FxRateService {
  constructor(private config: ConfigService) {}

  private get baseUrl(): string {
    return this.config.get<string>('FX_RATES_BASE_URL') || 'https://open.er-api.com/v6/latest';
  }

  async getRate(fromCurrency: string, toCurrency: string): Promise<number> {
    if (fromCurrency === toCurrency) return 1;
    const res = await fetch(`${this.baseUrl}/${fromCurrency}`);
    if (!res.ok) {
      throw new BadGatewayException("Impossible de recuperer le taux de change en ce moment.");
    }
    const data: any = await res.json();
    const rate = data?.rates?.[toCurrency];
    if (!rate) {
      throw new BadGatewayException(`Taux indisponible pour la paire ${fromCurrency}/${toCurrency}.`);
    }
    return rate;
  }
}
