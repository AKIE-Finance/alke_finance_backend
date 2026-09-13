import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'net';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventsModule } from '../src/common/events/events.module';
import { CommonModule } from '../src/common/common.module';
import { ThrottlingModule } from '../src/common/throttling.module';
import { AuthModule } from '../src/modules/auth/auth.module';
import { resetDatabase } from './helpers/db';

/**
 * Parcours d'authentification complet (blueprint §4.0 / §4.10) contre un vrai
 * serveur HTTP (port 0). Aucune dépendance supertest : `fetch` natif de Node.
 */
type Json = Record<string, unknown>;
interface Res<T = Json> { status: number; body: T }

const EMAIL = 'aline@alke.test';
const PHONE = '+237690000010';
const PASSWORD = 'MotDePasse!2026';

describe('Auth (HTTP e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.OTP_DEMO_MODE = 'true';
    process.env.OTP_DEMO_CODE = '123456';
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, EventsModule, CommonModule, ThrottlingModule, AuthModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
    await app.init();
    await app.listen(0);
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    prisma = app.get(PrismaService);
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  async function api<T = Json>(method: string, path: string, body?: unknown, token?: string): Promise<Res<T>> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'jest-e2e',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
  }

  interface Tokens { accessToken: string; refreshToken: string; expiresIn: number }

  it('register → OTP verify → login → refresh rotation → logout → password reset → OTP cap', async () => {
    // --- Inscription : pas de compte wallet, devise déduite du pays, OTP démo renvoyé.
    const reg = await api('POST', '/auth/register', {
      fullName: 'Aline Test', email: EMAIL, phone: PHONE, country: 'CMR', password: PASSWORD,
    });
    expect(reg.status).toBe(201);
    const userId = reg.body.userId as string;
    expect(userId).toBeTruthy();
    const otp = reg.body.otp as Json;
    expect(otp.debugCode).toBe('123456');
    const created = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(created.displayCurrency).toBe('XAF');
    expect(created.tokenVersion).toBe(0);
    const stored = await prisma.otpCode.findFirstOrThrow({ where: { destination: EMAIL } });
    expect(stored.codeHash).not.toContain('123456');

    // Mauvais format de téléphone / pays refusés par la validation.
    const bad = await api('POST', '/auth/register', {
      fullName: 'Bad', email: 'bad@alke.test', phone: '0690000010', country: 'FRA', password: PASSWORD,
    });
    expect(bad.status).toBe(400);

    // --- Vérification OTP d'inscription : ouvre la première session.
    const wrong = await api('POST', '/auth/otp/verify', { destination: EMAIL, purpose: 'REGISTER', code: '000000' });
    expect(wrong.status).toBe(400);
    const verified = await api<{ verified: boolean } & Tokens>('POST', '/auth/otp/verify', {
      destination: EMAIL, purpose: 'REGISTER', code: '123456', deviceLabel: 'iPhone test',
    });
    expect(verified.status).toBe(201);
    expect(verified.body.verified).toBe(true);
    expect(verified.body.accessToken).toBeTruthy();
    expect(verified.body.refreshToken).toBeTruthy();
    expect(verified.body.expiresIn).toBe(900);
    // Un code consommé ne sert qu'une fois.
    const replay = await api('POST', '/auth/otp/verify', { destination: EMAIL, purpose: 'REGISTER', code: '123456' });
    expect(replay.status).toBe(400);

    // --- Connexion classique.
    const badLogin = await api('POST', '/auth/login', { identifier: EMAIL, password: 'nope-nope-nope' });
    expect(badLogin.status).toBe(401);
    const login = await api<Tokens>('POST', '/auth/login', { identifier: PHONE, password: PASSWORD, deviceId: 'dev-1', deviceLabel: 'Pixel' });
    expect(login.status).toBe(201);
    const { accessToken, refreshToken } = login.body;
    expect(accessToken).toBeTruthy();

    // La session ne stocke que le hash du refresh token.
    const sessions = await prisma.session.findMany({ where: { userId } });
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.refreshTokenHash)).not.toContain(refreshToken);
    const pixel = sessions.find((s) => s.deviceId === 'dev-1');
    expect(pixel?.deviceLabel).toBe('Pixel');
    expect(pixel?.userAgent).toBe('jest-e2e');
    expect(pixel?.ipAddress).toBeTruthy();
    expect(pixel && pixel.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 86_400_000);

    const me = await api('GET', '/auth/me', undefined, accessToken);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(EMAIL);
    expect(me.body).not.toHaveProperty('passwordHash');

    const list = await api<Json[]>('GET', '/auth/sessions', undefined, accessToken);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(2);
    expect(list.body[0]).not.toHaveProperty('refreshTokenHash');

    // --- Rotation du refresh token : l'ancien est révoqué.
    const rotated = await api<Tokens>('POST', '/auth/refresh', { refreshToken });
    expect(rotated.status).toBe(201);
    expect(rotated.body.refreshToken).not.toBe(refreshToken);
    const oldAgain = await api('POST', '/auth/refresh', { refreshToken });
    expect(oldAgain.status).toBe(401);
    const unknown = await api('POST', '/auth/refresh', { refreshToken: 'not-a-token' });
    expect(unknown.status).toBe(401);

    // Révocation ciblée d'une session par id.
    const first = sessions.find((s) => s.deviceId !== 'dev-1');
    const del = await api('DELETE', `/auth/sessions/${first?.id}`, undefined, rotated.body.accessToken);
    expect(del.status).toBe(200);
    expect((await api('DELETE', `/auth/sessions/${first?.id}`, undefined, rotated.body.accessToken)).status).toBe(404);

    // --- Logout : le refresh courant ne fonctionne plus, l'accès reste valide jusqu'à expiration.
    const logout = await api('POST', '/auth/logout', { refreshToken: rotated.body.refreshToken }, rotated.body.accessToken);
    expect(logout.status).toBe(200);
    expect(logout.body.revoked).toBe(1);
    expect((await api('POST', '/auth/refresh', { refreshToken: rotated.body.refreshToken })).status).toBe(401);
    expect(await prisma.session.count({ where: { userId, revokedAt: null } })).toBe(0);

    // --- Réinitialisation du mot de passe : tokenVersion++ ⇒ ancien accès 401.
    const askReset = await api('POST', '/auth/otp/request', { destination: EMAIL, purpose: 'RESET_PASSWORD' });
    expect(askReset.status).toBe(201);
    const newPassword = 'NouveauMdp!2026';
    const reset = await api('POST', '/auth/password/reset', { destination: EMAIL, code: '123456', newPassword });
    expect(reset.status).toBe(201);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.tokenVersion).toBe(1);
    expect(after.passwordChangedAt).toBeInstanceOf(Date);
    expect((await api('GET', '/auth/me', undefined, rotated.body.accessToken)).status).toBe(401);
    expect((await api('POST', '/auth/login', { identifier: EMAIL, password: PASSWORD })).status).toBe(401);
    const relogin = await api<Tokens>('POST', '/auth/login', { identifier: EMAIL, password: newPassword });
    expect(relogin.status).toBe(201);
    expect((await api('GET', '/auth/me', undefined, relogin.body.accessToken)).status).toBe(200);

    // --- Changement de mot de passe connecté : nouveaux jetons, ancien accès invalide.
    const change = await api<Tokens>('POST', '/auth/password/change', { currentPassword: newPassword, newPassword: PASSWORD }, relogin.body.accessToken);
    expect(change.status).toBe(201);
    expect((await api('GET', '/auth/me', undefined, relogin.body.accessToken)).status).toBe(401);
    expect((await api('GET', '/auth/me', undefined, change.body.accessToken)).status).toBe(200);

    // --- Plafond OTP par destination : 5 par heure (repli ConfigValue), le 6e ⇒ 429.
    const dest = '+237690000099';
    for (let i = 1; i <= 5; i++) {
      const r = await api('POST', '/auth/otp/request', { destination: dest, purpose: 'LOGIN' });
      expect(r.status).toBe(201);
    }
    const sixth = await api('POST', '/auth/otp/request', { destination: dest, purpose: 'LOGIN' });
    expect(sixth.status).toBe(429);
    expect(String(sixth.body.message)).toMatch(/Trop de demandes/);

    // --- Journal d'audit alimenté par les événements de domaine.
    const actions = (await prisma.auditLog.findMany({ select: { action: true } })).map((a) => a.action);
    expect(actions).toContain('UserRegistered');
    expect(actions).toContain('UserLoggedIn');
    expect(actions).toContain('PasswordReset');
  });

  it('rejects blocked users and stale token versions at the guard', async () => {
    const reg = await api('POST', '/auth/register', {
      fullName: 'Bloqué Test', email: 'bloque@alke.test', phone: '+237690000011', country: 'CIV', password: PASSWORD,
    });
    expect(reg.status).toBe(201);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: reg.body.userId as string } })).displayCurrency).toBe('XOF');
    const login = await api<Tokens>('POST', '/auth/login', { identifier: 'bloque@alke.test', password: PASSWORD });
    expect(login.status).toBe(201);
    await prisma.user.update({ where: { id: reg.body.userId as string }, data: { isBlocked: true } });
    expect((await api('GET', '/auth/me', undefined, login.body.accessToken)).status).toBe(401);
    expect((await api('POST', '/auth/refresh', { refreshToken: login.body.refreshToken })).status).toBe(401);
    expect((await api('POST', '/auth/login', { identifier: 'bloque@alke.test', password: PASSWORD })).status).toBe(401);
  });
});
