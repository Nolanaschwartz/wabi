import { WelcomeController } from '../welcome.controller';

function makeController() {
  const welcome = jest.fn().mockResolvedValue(undefined);
  const controller = new WelcomeController({ welcome } as any);
  return { controller, welcome };
}

function member(guildId: string, id = 'm1') {
  return { id, guild: { id: guildId } } as any;
}

describe('WelcomeController (guildMemberAdd)', () => {
  beforeEach(() => {
    process.env.DISCORD_HUB_GUILD_ID = 'hub-guild';
  });

  it('delegates a join to the configured hub guild to WelcomeService', async () => {
    const { controller, welcome } = makeController();

    await controller.handleGuildMemberAdd(member('hub-guild', 'joiner'));

    expect(welcome).toHaveBeenCalledTimes(1);
    expect(welcome).toHaveBeenCalledWith('joiner');
  });

  it('ignores a join to a non-hub guild', async () => {
    const { controller, welcome } = makeController();

    await controller.handleGuildMemberAdd(member('some-other-guild'));

    expect(welcome).not.toHaveBeenCalled();
  });

  it('is inert when the hub guild is not configured', async () => {
    delete process.env.DISCORD_HUB_GUILD_ID;
    const { controller, welcome } = makeController();

    await controller.handleGuildMemberAdd(member('hub-guild'));

    expect(welcome).not.toHaveBeenCalled();
  });
});
