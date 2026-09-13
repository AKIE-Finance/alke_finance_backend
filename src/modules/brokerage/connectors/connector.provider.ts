import { NotImplementedException, Provider } from '@nestjs/common';
import { IOrderConnector, ORDER_CONNECTOR } from './connector.types';
import { FileConnector } from './file.connector';
import { SimulatedConnector } from './simulated.connector';

/** Picks the SDB connector from SDB_CONNECTOR (validated in env.validation.ts). */
export function createOrderConnector(kind: string = process.env.SDB_CONNECTOR ?? 'simulated'): IOrderConnector {
  switch (kind) {
    case 'simulated':
      return new SimulatedConnector();
    case 'file':
      return new FileConnector();
    case 'sftp':
    case 'api':
      throw new NotImplementedException(`Connecteur SDB « ${kind} » non disponible en v1.0.`);
    default:
      throw new NotImplementedException(`Connecteur SDB « ${kind} » inconnu.`);
  }
}

export const orderConnectorProvider: Provider = {
  provide: ORDER_CONNECTOR,
  useFactory: () => createOrderConnector(),
};
