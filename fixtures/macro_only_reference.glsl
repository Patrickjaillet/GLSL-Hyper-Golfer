#define a 3.0
#define TAU (2.0*a)

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    float velocity = 1.0;
    fragColor = vec4(velocity + TAU);
}
